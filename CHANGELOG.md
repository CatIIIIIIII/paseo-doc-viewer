# Changelog

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
