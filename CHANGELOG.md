# Changelog

## Unreleased

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
