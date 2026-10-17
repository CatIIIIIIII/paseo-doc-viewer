PDF and Office viewer opens the PDF, Word, Excel, CSV, PowerPoint, image, video and audio files in your workspace inside Paseo. It is meant for the files your agents produce: a report they rebuilt, a spreadsheet they exported, a deck they generated. You can check the result without leaving Paseo or copying the file to another machine.

Documents are rendered on the machine that runs your Paseo daemon, and the app only receives page images, text and table cells. This works on desktop, web and mobile, and over a relay connection, because the file never has to reach the device first. Everything it needs ships with the plugin: there is nothing to set up, and it does not use LibreOffice, Poppler, ffmpeg or any other program on the host.

## Opening documents

- The Documents button appears in the workspace header when the workspace scan finds at least one supported file and opens the Documents panel. It checks again every few seconds and disappears when no supported files remain. On a phone it shows as an icon. The panel can also be opened from the new tab menu, and on desktop and web it can sit in the explorer.
- The Documents panel lists the documents in the workspace under PDF, Word, Spreadsheets, PowerPoint, Images and Video headings, newest first within each, and refreshes every few seconds. Tap a heading to collapse it. Each heading shows how many files of that type the workspace has.
- Type buttons above the list show one type at a time, and the search box finds files whose name or folder contains every word you type, ignoring case. Search and type filters cover the whole workspace, not only the files in the list.
- The Command Center has two workspace actions: "Open recent document" opens the newest one, and "Show documents" opens the panel.
- The `/doc` slash command opens a document by its path in the workspace, or the newest one when you give no path.

An open document checks for changes every few seconds and shows the new version when an agent rewrites the file.

## Formats

- PDF: each page is rendered as an image at the width of the view, with page buttons to move through the document. Pinch with two fingers on iOS and Android, double tap, or use the zoom buttons to enlarge pages, slides and images up to 3x, re-rendered sharper, and drag with one finger to pan. The text button shows the page's text instead, which you can select or copy in one tap. A password-protected PDF asks for its password first.
- Word (.docx): a reading view with headings, paragraphs, lists, tables and pictures. It shows the content, not the printed page layout. Long documents are read in pieces as you scroll, and their footnotes are not shown.
- Excel (.xlsx): sheet tabs and a grid of cell values, paged 200 rows and up to 50 columns at a time, fewer columns on a phone. Numbers follow the cell's number format, such as percentages, currency, fixed decimals, thousands separators, times and durations. Dates show as year-month-day. A formula without a saved result shows as its formula text.
- CSV and TSV: the same grid as Excel, one sheet per file. Quoted fields, line breaks inside quotes and a UTF-8 byte order mark are handled; .csv splits on commas and .tsv on tabs. Text that is not UTF-8 is read as Latin-1.
- PowerPoint (.pptx): each slide's text and pictures in order. Zooming enlarges the text too. It does not reproduce the slide layout.
- Images: PNG, JPEG (with camera orientation applied), GIF, WebP, TIFF and HEIC/HEIF. Images smaller than the view are enlarged to fit it. TIFF, HEIC, WebP and GIF are converted on the daemon so every device can show them.
- Animated GIF and WebP play in the desktop, web and mobile apps. The mobile app plays animated WebP as a GIF converted on the daemon, so long or large WebP animations show their first frame there. Animations larger than 16 MB show their first frame everywhere.
- Video: MP4, M4V, MOV and WebM play with their original audio tracks in the desktop and web apps when the device supports the codecs. Files arrive in chunks and load completely before playback.
- Audio: MP3, M4A, WAV and FLAC use the same desktop/web player with play, pause, seek and volume controls. Codec support depends on the device.
- Find in document searches extracted PDF, Word, spreadsheet and slide text, including content outside the current view. Results open the page, text section or cell. PDF matches open selectable text rather than marking the page image. Ctrl/Cmd+F works while the viewer has focus. Large searches show partial counts and a Search more action; the list holds up to 500 results. Text extraction limits still apply, and scanned pictures are not searched.
- PDF and slide pages, image zoom and spreadsheet sheet/window positions are remembered when reopening. The reset button starts from the beginning. Positions are shared across clients using this daemon; Word scrolling and media playback time are not remembered yet.
- Download original prepares a file and then offers Save original in browser clients, including when previewing fails. It saves the original format and bytes, with a 128 MiB limit and a cancel action while preparing. Desktop save behavior needs verification inside Paseo; mobile save/share requires host support.

## Limits

- Video and audio do not play in the mobile app yet. It shows the file type and size instead. Media larger than 256 MiB does not play, and media over 32 MiB starts loading only when you ask.
- Clicking a file in the Files tree does not open it here, because Paseo does not let plugins handle file previews yet. Use the Documents panel, the Command Center or `/doc`.
- Each response is kept under 8 MB. Large pictures are scaled down to fit, and pictures that still do not fit are left out with a note. Very long cells are cut at 2,000 characters, and the text of a PDF page at 100,000 characters.
- File size caps: 512 MB for PDF, 64 MB for Word, Excel, CSV and PowerPoint, 128 MB for images. Office files that would unpack to more than the plugin can safely hold are refused. Images above 40 megapixels are not decoded.
- Only the first 500 sheets of a workbook are listed. Row and column counts of very large sheets may be estimates.
- Scanned PDF pages and text drawn as outlines have no text to show or copy.
- On a zoomed page, a fast swipe toward the right can still open Paseo's sidebar on Android, and on iOS the sidebar gesture takes priority over panning.
- The password of a protected PDF is sent to the daemon to open the file and is not stored. The viewer keeps it in memory while the document is open, so you enter it again when you reopen the document.
- PDFs with certificate security, password-protected Office files, and the older .doc, .xls and .ppt formats are not supported. You see a message saying so.

## What it reads

For document content, the plugin reads files inside the workspace directory. Paths that lead outside it, including through symbolic links, are refused. To build the recent list it scans the workspace, newest folders first, skipping hidden folders, `node_modules`, `__pycache__`, `venv`, `target`, `vendor`, and Office lock files. Build output in `build`, `dist` and `out` is scanned last. The list shows at most 50 files at a time; search or pick a type to reach older ones. In very large workspaces it stops after 50,000 entries, so search does not find files beyond that, and it reuses a scan for a few seconds (longer when scanning is slow) instead of repeating it for every request. It never writes project files. It stores up to 500 reading positions (at most 1 MiB of metadata, without passwords or document contents) in ~/.local/state/paseo-doc-viewer/positions.json on the daemon host, and makes no external network requests: rendered pages go only to your Paseo app.
