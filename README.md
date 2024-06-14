Aperture library importer for Aspect
====================================

This add-on allows you to choose an Aperture library and import its contents
into an Aspect library. The following elements will be imported:

- Files (RAWs, JPEGs and edited versions)
- Projects will be converted to events
- Folders will be replicated as groups in the collection pane
- Albums, books, light tables etc. will be imported as collections
- Keywords will be converted to XMP metadata

The add-on is written in a way that allows to re-run the import without causing
data duplication. As long as the imported collections/events do not get renamed,
this allows to run the import with newer versions of the add-on to profit from
later improvements.


Version compatibility
---------------------

This add-on requires Aspect version 1.0.0-preview.39 or later.


Installation
------------

Copy the "aperture-importer" folder of this repository into the add-on folder of
your Aspect installation. The folder can be found in the following location:

- Windows: %AppData%\Roaming\Bildhuus\Aspect\addons
- macOS: ~/Library/Aspect/addons
- Linux: ~/.config/aspect/addons

Note that you may need to create the folder if it doesn't exist, yet.


Known limitations
-----------------

The following elements are not currently imported:

- Metadata edits apart from keywords
- Files stored outside of the Aperture library
- Faces
- Image adjustments
- Image stacks
- Import history
- Sorting modes
