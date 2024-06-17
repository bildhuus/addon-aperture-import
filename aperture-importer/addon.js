registerAddon("bildhuus_aperture_importer", {
	version: "1.0.0",
	title: "Aperture Library Importer",
	vendor: "Bildhuus GmbH",
	description: "Allows to import Apple Aperture libraries into an Aspect library."
})

registerAction("importApertureLibrary", function() {
	var bundleurl = chooseFile({
			formats: [{
				name: "Aperture Library",
				patterns: ["*.aplibrary"]
			}]
		});
	if (bundleurl === null)
		return;

	var file = bundleurl + "/Database/apdb/Library.apdb";
	print("Opening database: " + file);

	if (!existsFile(file)) {
		alert("The main database file was not found. The folder you have selected does not appear to be an Aperture library bundle.", "Database not found");
		return;
	}

	try {
		var db = openSQLiteDatabase(file);

		// retreive all relevant database records
		print("Reading Aperture library database...");
		var folders = getFolders(db);
		var albums = getAlbums(db);
		var keywords = getKeywords(db);
		var versions = getVersions(db);
		var masters = getMasters(db);

		print("\nFolders: " + toJSON(folders));
		print("\nAlbums: " + toJSON(albums));
		print("\nKeywords: " + toJSON(keywords));
		//print("\nVersions: " + toJSON(versions));
		//print("\nMasters: " + toJSON(masters));

		// maps master uuid to library node
		var filenodes = {}

		// 1. convert all projects (folder type == 2) to events and import the
		// contained files
		print("Converting Aperture projects to events...");
		for (fuuid in folders) {
			var folder = folders[fuuid];
				print("FUUID " + fuuid);
				print("FOLDERS " + folders);
			if (folder.folderType == 2) {
				print("Creating event \""+folder.name+"\" for project with UUID \""+fuuid+"\"...");
				importProjectFolderAsEvent(library, bundleurl, fuuid, folder.name, versions, masters, filenodes);
				print("OUT");
			}
		}
		
		// 2. create matching folders for plain folders and convert all non-project
		// albums to collections
		print("Converting Aperture albums, books etc. to collections...");
		for (auuid in albums) {
			// check if this is an implicit project album
			var fuuid = albums[auuid].folderUuid;
			if (folders[fuuid] && folders[fuuid].implicitAlbumUuid != auuid) {
				print("Creating collection \""+albums[auuid].name+"\" for album with UUID \""+auuid+"\" of type "+albums[auuid].type+"...");
				createCollectionFromAlbum(library, albums[auuid], folders, versions, filenodes);
			}
		}

		// 3. generate XMP metadata for keywords and metadata contained in the
		// database - note that one XMP file is gerated for each version,
		// RAW/JPEG pairs share the same sidecar
		print("Converting Aperture metadata to XMP metadata...");
		for (vuuid in versions)
			generateMetadata(library, bundleurl, versions[vuuid], masters, keywords, filenodes);

		alert("The Aperture library has been imported successfully.",
			"Aperture Import Finished");
	} catch (e) {
		print(e);
		alert("An error occurred while importing the Aperture library: \n\n" + e,
			"Error importing library");
	}
});

addMenuEntry("importApertureLibrary", "Import Aperture Library…", "");


function importProjectFolderAsEvent(library, bundleurl, folder_uuid, project_name, versions, masters, filenodes)
{
	var files = []

	function addVerFile(ver, master_uuid)
	{
		if (!master_uuid) return;

		var path = getMasterFileURL(bundleurl, masters[master_uuid]);
		if (path) {
			var hidden = master_uuid != ver.masterUuid;
			files.push({
				path: path,
				hidden: hidden,
				versionUuid: vuuid,
				uuid: master_uuid
			});
		}
	}

	// collect all files of the project and determine whether the RAW or JPEG
	// is visible
	for (vuuid in versions) {
		var ver = versions[vuuid];
		if (ver.projectUuid == folder_uuid) {
			addVerFile(ver, ver.rawMasterUuid);
			addVerFile(ver, ver.nonRawMasterUuid);
		}
	}

	// determine which files still need to be imported and insert the remaining
	// ones into the filenodes map
	var importfiles = []
	var importuuids = []
	for (i in files) {
		// compute a quick partial checksum to determine whether the file is
		// already part of the library - we could use a full hash instead,
		// but that would mean reading every file twice during the process
		var wcs = calculateWeakChecksum(files[i].path);
		var dups = library.getWeakFiles(wcs);
		if (dups.length > 0) {
			filenodes[files[i].uuid] = dups[0];
		} else {
			importfiles.push(files[i].path);
			importuuids.push(files[i].uuid);
		}
	}

	// skip this event/project if all files have already been imported
	if (!importfiles.length)
		return;

	// create a new event to import into
	var evt = library.createEvent(project_name);

	// import the remaining files
	var impnodes = library.importFilesPlain(importfiles, evt);

	// insert imported files into the filenodes map
	for (i in impnodes)
		if (impnodes[i])
			filenodes[importuuids[i]] = impnodes[i];

	// apply the hidden state
	for (i in files) {
		if (files[i].hidden) {
			var n = filenodes[files[i].uuid];
			if(n) library.rootNode().hiddenItems().items().add(n);
		}
	}
}

function getMasterFileURL(bundleurl, master)
{
	if (master.fileVolumeUuid) {
		// TODO: support referenced files!
		print("Warning: skipping referenced file " + master.imagePath + " from volume " + master.fileVolumeUuid);
		return null;
	}

	return bundleurl + "/Masters/" + encodeInetPath(master.imagePath);
}

function createCollectionFromAlbum(library, album, folders, versions, filenodes)
{
	var grp = getLibraryFolderGroup(library, folders[album.folderUuid], folders);
	var collnode;

	// look for an existing collection
	if (grp === null) {
		library.rootNode().groupItems().forEach(function(itm) {
			if (itm.type() == "Collection" && itm.caption() == album.name)
				collnode = itm;
		});
	} else {
		grp.items().forEach(function(itm) {
			if (itm.type() == "Collection" && itm.caption() == album.name)
				collnode = itm;
		});
	}

	// create a new collection if none was found
	if (!collnode) {
		var colldata = {
			caption: album.name
		};

		collnode = library.createRawNode("Collection", colldata);
		if (grp === null) library.rootNode().groupItems().add(collnode);
		else grp.items().add(collnode);
	}

	// add all masters for all matching versions of the album
	for (i in album.versions) {
		var ver = versions[album.versions[i]];
		if (!ver) continue;
		function add(uuid) {
			var n = filenodes[uuid];
			if (n) collnode.items().add(n);
		}
		add(ver.masterUuid);
		if (ver.rawMasterUuid && ver.rawMasterUuid != ver.masterUuid)
			add(ver.rawMasterUuid);
		if (ver.nonRawMasterUuid && ver.nonRawMasterUuid != ver.masterUuid)
			add(ver.nonRawMasterUuid);
	}

	return collnode;
}


// Returns a group node for the given Aperture folder. Note that some folders
// are note mapped to a group node, in which case null will be returned instead.
function getLibraryFolderGroup(library, folder, folders)
{
	if (!folder || folder.parentFolderUuid == "TopLevelAlbums"
		|| folder.parentFolderUuid == "LibraryFolder")
	{
		return null;
	}

	var parentfolder = folders[folder.parentFolderUuid];
	var parent = getLibraryFolderGroup(library, parentfolder, folders);

	// look for an existing group
	var grpnode;
	if (parent === null) {
		library.rootNode().groupItems().forEach(function(itm) {
			if (itm.type() == "Group" && itm.caption() == folder.name)
				grpnode = itm;
		});
	} else {
		parent.items().forEach(function(itm) {
			if (itm.type() == "Group" && itm.caption() == folder.name)
				grpnode = itm;
		});
	}

	// create a new group if none was found
	if (!grpnode) {
		var grpnodeinfo = {
			caption: folder.name
		}
		grpnode = library.createRawNode("Group", grpnodeinfo);
		if (parent === null) library.rootNode().groupItems().add(grpnode);
		else parent.items().add(grpnode);
	}

	return grpnode;
}


function generateMetadata(library, bundleurl, version, masters, keywords, filenodes)
{
	var master = masters[version.masterUuid];
	var fil = filenodes[version.masterUuid];
	if (!master || !fil) return;

	var xmp = "";

	if (version.keywordUuids.length) {
		var subject = "    <dc:subject><rdf:Seq>";
		var hsubject = "    <lr:hierarchicalSubject><rdf:Seq>";
		for (i in version.keywordUuids) {
			var kwuuid = version.keywordUuids[i];
			var hkwd = "";
			do {
				var name = keywords[kwuuid].name;
				subject = subject + "<rdf:li>" + name + "</rdf:li>";
				hkwd = name + (hkwd != "" ? "|" + hkwd : "");
				kwuuid = keywords[kwuuid].parentUuid;
			} while (kwuuid !== null);
			hsubject = hsubject + "<rdf:li>" + hkwd + "</rdf:li>";
		}
		subject = subject + "</rdf:Seq></dc:subject>\n";
		hsubject = hsubject + "</rdf:Seq></lr:hierarchicalSubject>\n";

		xmp = xmp + subject + hsubject;
	}

	// TODO: rating, flagged, gps coordinates, derived from

	// skip if there is no metadata
	if (xmp == "") return;

	print("Adjusting metadata for " + fil.path() + "...");

	xmp = ''
		+ '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.6-c011 79.156380, 2014/05/21-23:38:37">\n'
		+ '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
		+ '  <rdf:Description\n'
		+ '    xmlns:xmpDM="http://ns.adobe.com/xap/1.0/DynamicMedia/"\n'
		+ '    xmlns:dc="http://purl.org/dc/elements/1.1/"\n'
		+ '    xmlns:lr="http://ns.adobe.com/lightroom/1.0/"\n'
		+ '    xmlns:tiff="http://ns.adobe.com/tiff/1.0/">\n'
		+ xmp
		+ '  </rdf:Description>\n'
		+ '</rdf:RDF></x:xmpmeta>';

	//print(xmp);

	// create the XMP sidecar file
	library.modifyFileMetadata(fil, xmp);
}

function getFolders(db)
{
	var stmt = db.prepare("SELECT uuid, name, folderType, parentFolderUuid, implicitAlbumUuid FROM RKFolder WHERE isInTrash=0");
	var ret = {};
	while (true) {
		var row = stmt.step();
		if (!row) break;
		ret[row[0].value+""] = {
			name: row[1].value,
			folderType: row[2].value,
			parentFolderUuid: row[3].value,
			implicitAlbumUuid: row[4].value
		}
	}
	stmt.finalize();
	return ret;
}

function getAlbums(db)
{
	var stmt = db.prepare("SELECT uuid, modelId, name, albumType, folderUuid FROM RKAlbum WHERE isInTrash=0 AND isMagic=0");
	var ret = {};
	while (true) {
		var row = stmt.step();
		if (!row) break;
		ret[row[0].value+""] = {
			name: row[2].value,
			type: row[3].value,
			folderUuid: row[4].value,
			versions: getAlbumVersions(db, row[1].value)
		}
	}
	stmt.finalize();
	return ret;
}

function findByID(items, id)
{
	for (var uuid in items) {
		if (items[uuid].id == id)
			return uuid;
	}
	return null;
}

function getKeywords(db)
{
	var stmt = db.prepare("SELECT modelId, uuid, name, parentId FROM RKKeyword");
	var ret = {};
	while (true) {
		var row = stmt.step();
		if (!row) break;
		var parentuuid = row[3].value ? findByID(ret, row[3].value) : null;
		ret[row[1].value+""] = {
			id: row[0].value,
			name: row[2].value,
			parentUuid: parentuuid
		}
	}
	stmt.finalize();
	return ret;
}


// versions of the same file or raw/jpeg pair
function getVersions(db)
{
	var stmt = db.prepare("SELECT modelId, uuid, fileName, masterUuid, rawMasterUuid, nonRawMasterUuid, projectUuid, mainRating, isHidden, isFlagged, exifLatitude, exifLongitude FROM RKVersion WHERE isInTrash=0");
	var ret = {};
	while (true) {
		var row = stmt.step();
		if (!row) break;
		ret[row[1].value+""] = {
			fileName: row[2].value,
			masterUuid: row[3].value,
			rawMasterUuid: row[4].value,
			nonRawMasterUuid: row[5].value,
			projectUuid: row[6].value,
			mainRating: row[7].value,
			isHidden: row[8].value,
			isFlagged: row[9].value,
			exifLatitude: row[10].value,
			exifLongitude: row[11].value,
			keywordUuids: getVersionKeywordUuids(db, row[0].value)
		}
	}
	stmt.finalize();
	return ret;
}

function getVersionKeywordUuids(db, version_id)
{
	var stmt = db.prepare("SELECT RKKeyword.uuid FROM RKKeyword INNER JOIN RKKeywordForVersion ON RKKeywordForVersion.keywordId=RKKeyword.modelId AND RKKeywordForVersion.versionId=:VERSION", {":VERSION": version_id});
	var ret = []
	while (true) {
		var row = stmt.step(); 
		if (!row) break;
		ret.push(row[0].value);
	}
	return ret;
}

// physical files
function getMasters(db)
{
	var stmt = db.prepare("SELECT uuid, fileName, projectUuid, fileVolumeUuid, originalVersionUuid, imagePath FROM RKMaster WHERE isInTrash=0");
	var ret = {};
	while (true) {
		var row = stmt.step();
		if (!row) break;
		ret[row[0].value+""] = {
			fileName: row[1].value,
			projectUuid: row[2].value,
			fileVolumeUuid: row[3].value,
			originalVersionUuid: row[4].value,
			imagePath: row[5].value
		}
	}
	stmt.finalize();
	return ret;
}

function getAlbumVersions(db, album_id)
{
	var stmt = db.prepare("SELECT RKVersion.uuid FROM RKVersion INNER JOIN RKAlbumVersion ON RKAlbumVersion.versionId=RKVersion.modelId AND RKAlbumVersion.albumId=:ALBUM", {":ALBUM": album_id});
	var ret = []
	while (true) {
		var row = stmt.step(); 
		if (!row) break;
		ret.push(row[0].value);
	}
	return ret;
}

function stripExtension(path)
{
	if (path.length == 0)
		return path;

	var idx = path.length - 1;
	while (idx >= 0 && path.charAt(idx) != '/' && path.charAt(idx) != '\\')
		idx--;

	var didx = path.length - 1;
	while (didx >= 0 && path.charAt(didx) != '.')
		didx--;

	return didx > idx ? path.substr(0, didx) : path;
}
