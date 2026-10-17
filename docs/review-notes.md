# Review notes

Branch: `feat/viewer-usability-and-audio`, based on `a5924d6` (0.3.0).
Implemented and checked on 16 October 2026. No release has been published.

## What to review

1. Conditional workspace header icon, from the existing scan, polled every 30 seconds
   per workspace with backoff on failure.
2. Desktop/web MP3, M4A, WAV and FLAC playback with native controls and decoder
   errors. Video retains its original sound. Native media remains gated off.
3. Durable PDF/slide page and zoom, image zoom, and spreadsheet sheet/window
   position. Reset controls included. Metadata is shared by clients of a daemon;
   no passwords or document text are saved. Word/media position is deferred.
4. Find across PDF, Word, Excel/CSV and slides, with bounded cursors, partial
   counts, 500-result display cap and navigation/highlighting. PDF uses text mode;
   Word opens the matching reading segment. Existing extraction limits apply.
5. Browser Download original, available even if preview fails, with preparation,
   progress/cancel and a second explicit Save link. Original-byte cap: 128 MiB.
6. Concrete host API proposals for file-tree opening, native save/share and
   progressive media, rather than unusable plugin-side substitutes.

## Review history

- [Product review before implementation](adversarial-feature-review.md): challenges
  the requested behavior and records the scope decisions.
- [Code review after implementation](adversarial-code-review.md): findings,
  hardening, regression evidence and residual limitations. Both passes were
  performed by the implementing agent; no claim of independent review.
- [Host API proposals](host-api-proposals.md): follow-up specifications, unpublished.
- [Full roadmap](feature-roadmap.md): intended direction and acceptance criteria.

## Validation

- `npm run typecheck`: passed, including the browser harness's DOM-specific config.
- `npm test`: 341 passed; 2 skipped; 1 existing todo.
- Skipped checks require Paseo's own configured source/compiler or Hermes VM
  binaries; the native playback todo requires host SDK support. The regular
  install-style client/server bundle checks pass.
- Chromium browser harness passed: page/zoom/sheet restoration, reset, scoped
  Ctrl+F focus, keyboard scrolling after a click, PDF/Word/grid search navigation,
  exact original download contents, WAV decoding/playback, WebM playback with one
  unmuted audio track, stale-query response rejection, cancelled download
  preparation, and late position reads (no writes). Each race check fails with
  its guard removed.
- Browser checks use real components/RPC handlers with a test DOM adapter; actual
  Paseo desktop and native layout/gesture/save checks remain for manual review.
  Headless media tests verify decoding/progress/tracks, not physical speakers.
- `git diff --check`: passed.

## Try it

```sh
npm ci
npm run typecheck
npm test
npx playwright install chromium
npm run test:browser
```

For the browser harness, `CHROMIUM_EXECUTABLE_PATH` can select an existing binary.
The restricted execution environment used a locally extracted serverless Chromium
153 binary after the normal Playwright download failed. No binary is added to the
repository. Screenshots are generated under `node_modules/.cache/viewer-browser`.

To test inside Paseo, install this branch with the normal repository installer:

```sh
paseo plugin install git:nkwib/paseo-doc-viewer#feat/viewer-usability-and-audio
```

Suggested manual checks: open a multi-page PDF, navigate/zoom, close/reopen, reset;
search a later page and a later sheet; change a file while searching; prepare and
save a locked/unsupported original; play audio/video in the actual desktop host;
check narrow-screen search controls and native fallback messages.

## Persistence

Default metadata path: `~/.local/state/paseo-doc-viewer/positions.json` on the
daemon. Override with an absolute `PASEO_DOC_VIEWER_STATE_DIR`, especially when
running several daemons under the same OS account. History retains at most 500
entries and 1 MiB, with private file permissions and atomic serialized writes.
No project files are changed. A failed/slow load falls back to reading without
writing default state over unavailable history.
