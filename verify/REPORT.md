# Live verification on Paseo 0.11.2 (web UI)

Web run against an early build on Paseo 0.11.2. Isolated daemon (`paseo daemon run --home /tmp/...`, `PASEO_LISTEN` on a free port, `"pluginsEnabled": true`, bundled web UI from the Paseo app). The plugin was installed as a Git `file://` source, so the manifest build `npm ci --omit=dev --ignore-scripts` ran. Driven with Playwright and Chrome. `~/.paseo` and the daemon on port 6767 were not touched.

| Scenario | Result | Screenshot |
| --- | --- | --- |
| Documents panel, reorders 0.4 s after a touch | PASS | 01, 18 |
| PDF page, crisp at DPR 2 (2304 px bitmap for a 1048 px view), navigation | PASS | 02, 03, 04 |
| S3 rebuild with more pages while on page 2 | PASS, new image at 2.7 s | 05, 06 |
| S3 rebuild from 5 to 3 pages while on the last page | PASS, 1.3 to 4.1 s (was 9 s) | 07 |
| docx | PASS, table frame wider than its columns | 08 |
| xlsx sheet tabs | PASS | 09, 10 |
| xlsx rebuilt from 3 to 2 sheets while on the last sheet | PASS, moves to the new last sheet in 1.2 s | 10b |
| Streamed xlsx, 150k rows by 10 columns | FAIL, bugs 1 and 2 | 19, 20 |
| pptx, GIF, JPEG with EXIF orientation 6, mp4 on web, TIFF, HEIC | PASS | 11 to 16, 21, 22 |
| Password-protected PDF, encrypted docx | PASS | 17, 23 |
| 400 MiB pptx bomb shows "too large", plugin keeps running, next document opens | PASS, bug 3 | 24, 25 |
| Browser console | PASS, no errors | |

## Bugs

1. Sheets written without a `<dimension>` element report 0 rows, so the grid snaps back to the first 200 rows and later rows cannot be reached.
2. The row label shows an estimated count as exact ("of 201" for 150,001 rows).
3. Error details include the host's RPC suffix (`requestType=plugin.rpc.invoke.request code=handler_error`).

## Mutation testing

53 mutants, 41 killed. Surviving and worth fixing: a failed computation stays cached (`server/cache.ts:70`), no slide text budget (`server/pptx.ts:58`), one image can take a slide's whole image budget (`server/pptx.ts:107`). The other survivors are equivalent or low impact.

## Fixed after this run

Bugs 1 to 3 and the three surviving mutants are fixed, each with a test.

## Device runs (v0.1.0)

Paseo 0.11.4 daemon in an isolated home, plugin installed from Git.

- Android, Pixel 10 Pro, Paseo 0.11.4 from the Play Store: every format, page navigation, zoom buttons, pinch and double tap, live file updates, plugin crash and `paseo plugin reload`. This run found an out-of-memory crash on a 300-column sheet (now a windowed grid, peak about 1.9k views instead of 42k), a pan offset after zooming out, and clipped cell text. All three are fixed and re-checked on the device.
- iOS simulator, iPhone 18 Pro, iOS 27.0, app built from Paseo main: the same scenarios pass. The fixes for its toolbar layout notes are not yet re-checked on a device.
