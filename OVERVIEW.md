PDF and Office viewer opens the PDF, Word, Excel, PowerPoint, image and video files in your workspace inside Paseo. It is meant for the files your agents produce: a report they rebuilt, a spreadsheet they exported, a deck they generated. You can check the result without leaving Paseo or copying the file to another machine.

Documents are rendered on the machine that runs your Paseo daemon, and the app only receives page images, text and table cells. This works on desktop, web and mobile, and over a relay connection, because the file never has to reach the device first. Everything it needs ships with the plugin: there is nothing to set up, and it does not use LibreOffice, Poppler, ffmpeg or any other program on the host.

## Opening documents

- The Documents panel, in the workspace and (on desktop and web) in the explorer, lists the most recently changed documents in the workspace, newest first, and refreshes every few seconds.
- The Command Center has two workspace actions: "Open recent document" opens the newest one, and "Show documents" opens the panel.
- The `/doc` slash command opens a document by its path in the workspace, or the newest one when you give no path.

An open document checks for changes every few seconds and shows the new version when an agent rewrites the file.

## Formats

- PDF: each page is rendered as an image at the width of the view, with page buttons to move through the document. Pinch with two fingers on iOS and Android, double tap, or use the zoom buttons to enlarge pages, slide pictures and images up to 3x, re-rendered sharper, and scroll with one finger to pan. The text button shows the page's text instead, which you can select or copy in one tap.
- Word (.docx): a reading view with headings, paragraphs, lists, tables and pictures. It shows the content, not the printed page layout. Long documents are read in pieces as you scroll, and their footnotes are not shown.
- Excel (.xlsx): sheet tabs and a grid of cell values, paged 200 rows and up to 50 columns at a time, fewer columns on a phone. Numbers follow the cell's number format, such as percentages, currency, fixed decimals and thousands separators, and dates show as year-month-day. A formula without a saved result shows as its formula text.
- PowerPoint (.pptx): each slide's text and pictures in order. It does not reproduce the slide layout.
- Images: PNG, JPEG (with camera orientation applied), the first frame of a GIF or animated WebP, WebP, TIFF and HEIC/HEIF. TIFF, HEIC, WebP and GIF are converted on the daemon so every device can show them.
- Video: MP4, M4V, MOV and WebM play in the desktop and web apps. The file is streamed from the daemon in chunks.

## Limits

- Video does not play in the mobile app yet. It shows the file type and size instead. Videos larger than 256 MB do not play anywhere, and videos over 32 MB start loading only when you ask.
- Clicking a file in the Files tree does not open it here, because Paseo does not let plugins handle file previews yet. Use the Documents panel, the Command Center or `/doc`.
- Each response is kept under 8 MB. Large pictures are scaled down to fit, and pictures that still do not fit are left out with a note. Very long cells are cut at 2,000 characters, and the text of a PDF page at 100,000 characters.
- File size caps: 512 MB for PDF, 64 MB for Word, Excel and PowerPoint, 128 MB for images. Office files that would unpack to more than the plugin can safely hold are refused. Images above 40 megapixels are not decoded.
- Only the first 500 sheets of a workbook are listed. Row and column counts of very large sheets may be estimates.
- Scanned PDF pages and text drawn as outlines have no text to show or copy.
- Password-protected and encrypted files, and the older .doc, .xls and .ppt formats, are not supported. You see a message saying so.

## What it reads

The plugin reads files inside the workspace directory and nothing else. Paths that lead outside it, including through symbolic links, are refused. To build the recent list it scans the workspace, newest folders first, skipping hidden folders, `node_modules`, `__pycache__`, `venv`, `target`, `vendor`, and Office lock files. Build output in `build`, `dist` and `out` is scanned last. In very large workspaces it stops after 50,000 entries, and it reuses a scan for a few seconds (longer when scanning is slow) instead of repeating it for every request. It does not write files, and it makes no network requests: rendered pages go only to your Paseo app.
