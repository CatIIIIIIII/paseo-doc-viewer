# Changelog

## Unreleased

- PDF page map: a Pages button shows a grid of low-resolution page thumbnails (2 or 3 columns on phones). Thumbnails load visible pages first, at most two at a time per map, on one background render slot that never takes the last slot from page renders. Closing the map stops further requests; a tap opens the page. New `doc.thumbnail` RPC (PDF only, 48 to 320 px wide, under 256 KB).
- Page pins: pin the current page from the page map with an optional label (up to 60 characters, 30 pins per document). Each pin keeps the file revision it was saved with; after a rewrite it shows "May need checking" until confirmed, or says the page no longer exists. New `viewer-state.pin` RPC; `viewer-state.read` also returns `pins` and `review`.
- Review marks: Mark reviewed records the revision on screen. Documents shows a check for reviewed files and "Changed since review" once the file changes, with a Needs review filter. Opening, scrolling or a saved position never marks a file reviewed, and a file that changed before the press is not marked. New `viewer-state.review` RPC; `docs.recent` takes `needsReview` and returns a per-entry `review` and a `needsReview` count.
- Review notes: Add note in the PDF toolbar adds a note to the page you are viewing, optionally with that page's image. Notes from any file in the workspace collect in a Review notes screen, where you can edit or remove them and preview the exact message, then copy it or send it to an agent you choose in the workspace. Notes on a file that has changed since are marked as an older revision. Sending only goes to an agent with no turn in progress and no pending permission; a busy agent is never interrupted, and a refused or failed send keeps the draft. Drafts live in app memory only (up to 50 notes of 2,000 characters). New `review.page-image` RPC renders an attached page at the note's revision, at most 2000 px per side and 5 images per review.
- Spreadsheet cell inspector: tap a cell to see its sheet-qualified address, formula, saved result, raw value, type and number format. A formula without a saved result is shown as information. Shared formulas that cannot be adjusted exactly name their master cell instead of showing a reconstructed formula. `doc.rows` takes `detail` and returns per-cell `details`.
- Record view: read one spreadsheet row at a time as a vertical card, labelled by a header row you choose. The grid stays the default.
- Issue check for Excel workbooks: lists error cells and formulas without a saved result, states which rows were inspected and where a bounded check paused (3 s, 250,000 rows or 200 issues per call), and jumps to the cell. New `doc.issues` RPC.
- The PDF toolbar fits a 390 px phone: on compact layouts Find, Pages, Add note, Review notes and Mark reviewed are icon-only, and Add note sits with the review controls instead of the page controls.
- Find in PDF: matches are highlighted in place on the rendered page and the page scrolls to the selected match, instead of always switching to the extracted text. `doc.search` returns normalized `boxes` for PDF matches, computed from PDFium's character boxes; a match without page geometry still opens the page text.
- Audio plays in the mobile apps: a Play button streams the file and hands it to the host's `playAudio` (Paseo 0.11.2 and later), capped at 32 MiB. Playback runs to the end of the file with no pause or seek; on hosts without `playAudio` the viewer shows the availability message as before.
- Audio: MP3, M4A, WAV and FLAC play in the desktop and web apps with play, pause, seek and volume, listed under a new Audio heading.
- Reading positions: PDF and slide page, zoom and text mode, image zoom, and spreadsheet sheet index and row/column window are restored when a file is reopened, shared by every client of the daemon. They are stored on the daemon host under `$PASEO_DOC_VIEWER_STATE_DIR`, `$XDG_STATE_HOME/paseo-doc-viewer` or `~/.local/state/paseo-doc-viewer`, keyed by an HMAC of the path with a per-install secret (0600). New `viewer-state.read` and `viewer-state.write` RPCs.
- Find in document for PDF, Word, Excel, CSV and PowerPoint text (`doc.search`). Each call scans for up to 3.5 s or 50 matches and returns a cursor; the panel keeps going on its own up to 500 results. CSV and xlsx sheets are streamed once per search, xlsx shared strings are matched once per query, the scan yields to other requests every 40 ms, and a newer search from the same panel stops the older one. The selected match is highlighted and scrolled into view.
- Download original (`file.info`, `file.chunk`): saves the original bytes, also when previewing fails, up to 128 MiB. Only supported file types outside hidden files and folders, and the opened file must still be the one the workspace path resolves to.
- The Documents header button appears only in workspaces with documents. It checks with the new `docs.any` RPC every 2 minutes, two workspaces at a time, backing off to 10 minutes after errors.
- Workspace lookups ask the daemon for the one workspace by id instead of paging through all of them.
- Android: the bottom inset uses the SDK's `useSafeAreaInsets` when a host exports it, and is re-measured when the window size changes.

## 0.3.0 (2026-10-16)

- Documents panel: files are grouped under collapsible PDF, Word, Excel, PowerPoint, Images and Video headings with counts, newest first within each group.
- Documents panel: type filter buttons and a search box (name or folder, case-insensitive, every word must match). `docs.recent` takes optional `query` and `group` and filters the whole scan before the 50-entry cap, so older files are found. It also returns per-type `counts`.
- A Documents button in the workspace header opens the panel (icon only on phones). The panel uses the FileStack icon so it no longer looks like the built-in Files tab.
- CSV and TSV open in the sheet grid, paged with the Excel row, column and cell caps, 64 MB file cap. They are listed under Spreadsheets (was Excel) and found by search, the type filter, the Command Center and `/doc`.
- Android: lists, grids and pages end above the system navigation bar. The SDK has no safe-area insets for plugins, so the viewer pads the part of its frame that overlaps the navigation bar, using the bottom inset the app reported at launch (48 dp if unknown).
- Zoomed pages, slides and images: the viewer takes one-finger drags from touch start and pans itself, with a short fling on release. On Android a fast swipe to the left no longer opens the sidebar; a fast swipe to the right still can.
- PowerPoint: slide text scales with zoom, and text-only slides can be zoomed.
- Images smaller than the view, such as a small animated WebP, are enlarged to fit it instead of showing at pixel size.
- PDF text view: the copy button takes the zoom controls' slot, so the page counter and next button no longer move.
- Animated GIF and WebP play on desktop, web, iOS and Android. `doc.open` reports `animation` for files with more than one frame up to 16 MB, and `media.chunk` serves their original bytes. Larger files keep the first frame. The mobile apps cannot play animated WebP, so they request `media.chunk` with `mimeType: "image/gif"` and the daemon converts the WebP to GIF with imagescript (up to 500 frames, 32 million decoded pixels and a 16 MB GIF; above that the first frame stays).
- PDF: a password-protected PDF shows a password field and opens with the right password; a wrong one shows an error. `doc.open`, `doc.page` and `doc.text` take an optional `password`, and the error codes `password_required` and `password_incorrect` replace `password_protected`. The app keeps the password in memory for the open document and sends it with each request. The daemon uses it only to open the file: it is not logged or stored, and caches are keyed by a salted hash, so the 60 s PDFium recycle reopens the file with the resent password.
- An open document is still re-read every 5 s to pick up changes, but one that failed to open (including a locked PDF waiting for its password) is not, so the password field keeps what was typed. Retry reopens it.
- On iOS and Android the password field stays above the keyboard with the error line visible, and the keyboard stays open after a wrong password.

## 0.2.0 (2026-10-16)

- Excel: numbers follow the cell's number format (percent, currency, fixed decimals, thousands separators, custom codes) using SheetJS ssf. General numbers no longer show float noise (0.1 + 0.2 shows 0.3). Times, durations and date-times follow their format (18:00, 36:00, 2026-01-14 18:00); pure dates still show as YYYY-MM-DD.
- PDF: a text button shows the current page's text as selectable text, with a copy button. New `doc.text` RPC, capped at 100,000 characters per page.
- PDF: PDFium and its open documents are released after 60 s without PDF work and reloaded on the next request, so the daemon gives back the memory of a large render.

## 0.1.1 (2026-10-16)

- Renamed to "PDF and Office viewer" (plugin id unchanged). New first listing image showing desktop, iOS and Android.
- Each render job now times out after 20 s and frees its slot, so a hung read can no longer block every later document.
- Rendered pages are capped at 3072 px on the long edge (was 4096).
- The recent list shares one workspace scan between concurrent requests and reuses it for at least 4 s.
- The recent list now includes `build`, `dist` and `out`, scanned after other folders.
- CI: typecheck and tests on push and pull requests, plus a weekly install check against Paseo main.

## 0.1.0 (2026-10-16)

- First release: PDF, Word, Excel, PowerPoint, image and video files from the workspace, rendered on the daemon host, on desktop, web and mobile.
- Documents panel, Command Center actions and the `/doc` slash command.
