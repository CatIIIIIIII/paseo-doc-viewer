# Document viewer feature roadmap

Status: plugin-supported features implemented on `feat/viewer-usability-and-audio`.
See [review-notes.md](review-notes.md) for verified scope and remaining limitations.
Word/media position restoration and all host-dependent integrations remain deferred.
Baseline: repository a5924d6, pinned plugin SDK 0.11.2.

## Delivery order

| Phase | Deliverable | Dependency |
| --- | --- | --- |
| 0 | Conditional Documents icon | Implemented; uses the existing bounded workspace scan |
| 1 | Remember reading position | Implemented for pages, zoom and sheet windows; Word/media deferred |
| 2 | Desktop/web audio and video-sound verification | Implemented; browser playback verified |
| 3 | Find inside documents | Implemented for PDF, Word, spreadsheets and slides |
| 4 | Download original on desktop/web | Browser download implemented and verified; actual desktop host check pending |
| 5 | Open from file tree; mobile save/share | Paseo host SDK extensions |
| 6 | Progressive media and full mobile playback | Host transport and native media API |

Phases 1–4 can be delivered independently. Prepare host API proposals early;
do not hold plugin releases while those proposals wait for upstream acceptance.
Split phase 3 into PDF/Word/PowerPoint and spreadsheet deliveries if necessary.

## 1. Remember reading position

### User behavior

- Reopening a PDF or deck restores its page/slide and zoom. Images restore zoom.
- Spreadsheets restore the selected sheet and row/column window.
- Word restores the nearest visible content block, loading preceding blocks as
  necessary. Ship this after paged formats because block loading is incremental.
- Once media exists, restore playback time after metadata loads, but require an
  explicit play action. Volume and mute are client preferences, not file state.
- Provide a Reset position action for the open document.

### Implementation

- Add a versioned viewer-state model and storage adapter. Use workspace ID,
  normalized relative path and document kind as the logical key; store revision
  alongside the position rather than inside the key.
- Recommended initial semantics: positions follow the daemon across authorized
  clients. This is shared host state, not private per-device history; concurrent
  windows use the last accepted server write. Do not imply separate user profiles.
- Persistence spike: verify host settings size and write semantics before using
  the SDK's host-scoped settings for a bounded state map. If unsuitable, use
  dedicated read/write RPCs and an atomic, serialized store in a plugin-owned
  state directory outside the workspace. Resolve directory ownership before
  implementation; do not assume a storage API or write into project files.
- Bound retention to 500 documents, evict least recently used entries, and debounce
  writes by roughly one second. Flush best-effort on navigation; do not depend on
  unmount or process shutdown for durability. A storage failure must not prevent
  opening a document. Never store passwords, document contents or search queries.
- Hydrate before saving defaults. Guard delayed loads/writes against switching
  documents. Clamp page, zoom and grid offsets using `client/paging.ts` helpers.
- On a changed revision, preserve valid page/sheet positions and clamp invalid
  values. Reset fragile Word anchors and media time on content changes. Match
  sheets by name with index fallback. Renames start fresh in v1.
- Wire into `document-screen.tsx`, `page-viewer.tsx`, `sheet-viewer.tsx`,
  `blocks-viewer.tsx` and the future shared media viewer. Explicitly key every
  viewer by document identity so state does not leak between files.
- Update the overview if persistent state introduces daemon writes.

Acceptance: restore after close/reopen and daemon restart; no cross-file state;
safe defaults after corruption, removed pages/sheets, concurrent writes, or failed
persistence; no password persistence.

## 2. Audio files and video sound

Use [audio-support-plan.md](audio-support-plan.md) for detailed file and SDK changes.

- Verify existing audible video with known audio-track fixtures on desktop/web;
  the current player already retains audio and is not muted.
- Add MP3, M4A, WAV and FLAC discovery, MIME/signature handling, RPC schemas,
  browse grouping, and an HTML audio player with native controls.
- Share bounded chunk loading, progress, retry, revision checks and Blob cleanup
  with video. Handle browser decoder failures separately from transfer failures.
- Retain the current 256 MiB desktop/web cap and 32 MiB autoload threshold initially.
  These are full-file playback limits, not streaming guarantees.
- Treat basic mobile `playAudio` as an optional separate release. No promise of
  pause, seek or stop when leaving the screen: the pinned SDK does not expose
  those controls. Prefer waiting for a richer host API for long-form audio.

Acceptance: audible fixtures, functional desktop/web controls, no autoplay,
audio-only workspaces reveal the icon, cleanup/retry works, unsupported codecs
produce an actionable message. Native behavior must be tested on actual targets.

## 3. Find inside documents

### User behavior

- A Find button opens a query field, match count, and previous/next navigation.
  Desktop/web supports Ctrl/Cmd+F while the viewer owns focus; clean up shortcuts
  on exit. Mobile uses the same visible controls without relying on shortcuts.
- Search the current file only. Start with case-insensitive literal matching,
  not regex, OCR, semantic retrieval, or workspace-wide full-text indexing.
- Results navigate to a page, slide, Word block, or spreadsheet cell. Show a
  snippet and highlight in text/cell views. PDF results initially open text mode;
  visual highlights on rendered PDF pages need text coordinates and are later work.
- Show searching, partial results, completion, no-match and unsupported states.
  Never label a partial count as the total number of matches.

### Implementation

- Add `doc.search` contracts in `shared/rpc.ts` with a query capped at 200 chars,
  revision-bound cursor, bounded result batch, typed navigation target, completion
  flag and coverage/truncation details. Reuse workspace confinement and password
  handling; send PDF passwords per request and keep them out of search caches.
- Search server-side in resumable batches under the 20-second RPC deadline and
  8 MiB response limit. Start conservatively with at most 50 returned matches and
  a small work budget per request; tune on representative fixtures. Stop client
  requests when the query changes or the view closes; discard stale responses.
- Reuse PDF text extraction, Word block readers, deck text and spreadsheet/CSV
  iterators. Search all sheets in row/column windows, independent of visible cells.
  Decide and document spreadsheet semantics: displayed text and saved formula
  results; formula strings where no saved result exists, matching the viewer.
- Track scanned units as well as matches. Preserve a within-unit cursor so a
  page with many matches does not skip results between batches. Report text/cell
  extraction caps and unsupported content as incomplete coverage.
- Key optional bounded caches by file revision and normalized query; do not
  build an unbounded whole-document index. Invalidate on file changes. A changed
  revision restarts the search rather than mixing old and new results.
- Introduce typed navigation actions shared by search and remembered position.
  Jumping to an arbitrary spreadsheet cell must preserve working previous/next
  navigation; Word must load the target block before scrolling.

Acceptance: matches outside the current page/window, correct navigation and
highlighting, query changes during loading, revised files, empty/scanned PDFs,
Unicode text, late spreadsheet cells and explicit partial-coverage indicators.

## 4. Download/export original

Scope: save the original bytes, filename and extension. Converting to another
format is separate. Make the action available even when rendering is unsupported
or the document is too large to preview, provided the file can be resolved safely.

- First prototype a real click-triggered Blob download in supported browsers and
  Paseo desktop. Web capability does not by itself prove that desktop handles
  downloads. Verify user activation after asynchronous loading; if needed, load
  first and offer a second explicit Save action. Only advertise tested targets.
- Add generic `file.info` / `file.chunk` RPCs rather than forcing original exports
  into video/image-only `media.chunk` schemas. Reuse path confinement, response
  bounds and revision checks. Include progress, cancel, retry and safe filenames.
- Set an initial 128 MiB Blob-download cap, separate from preview limits; validate
  memory use on target clients before raising it. Do not decode or render files
  merely to download them. An encrypted PDF exports its original encrypted bytes.
- On a file change, stop and retry rather than assembling mixed revisions.
- Mobile requires a host save/share API. Show the action only when a supported
  capability is available. Large exports eventually use the transport in phase 6.

Acceptance: byte-identical output and correct name/type, working desktop/web save,
unsupported-preview export, interrupted transfer, changed revision, size cap and
no outside-workspace or symlink escape.

## 5. Open directly from the file tree

This cannot be implemented through the pinned plugin SDK alone.

- Propose a host file-opening contribution with supported extensions, an
  availability predicate and workspace/path context. Host UI should offer
  Open with Document Viewer and a configurable default for supported formats.
- Route to the existing `documentScreen(workspaceId, path)` helper. Preserve the
  host's ordinary handling of unsupported files and expose an alternative handler
  when more than one plugin claims a format. Define single-click versus explicit
  Open with behavior in the host proposal before implementation.
- Host dispatch must target the correct daemon/workspace and refuse stale plugin
  registrations. The plugin still validates the path on the server.
- Register only when the host capability exists; retain the panel, command and
  slash command entry points on older hosts. Raise minimum Paseo version only if
  feature detection is unavailable.

Acceptance: correct file/workspace on desktop and mobile, unavailable plugin,
unsupported extensions, competing handlers, reload/uninstall and older hosts.
Deliver the host proposal as a reviewable specification; publishing it is separate.

## 6. Progressive media and native playback

- First agree a host-owned, authenticated, seekable source usable directly by
  browser/native players. A custom RPC range reader alone is not a media URL.
  Do not add a separate public server or leak daemon credentials into URLs.
- Verify direct and relay paths, encrypted transport behavior, browser/WebView
  authentication, origin handling, expiry/revocation and cancellation before
  committing to HTTP range endpoints. The pinned plugin server context has no
  arbitrary HTTP-route registration API.
- Support byte ranges and correct 200/206/416 responses, MIME and length metadata,
  validators tied to revision, reconnect behavior and bounded per-client buffers.
  Seeking must fetch the relevant bytes without retaining the entire file.
- MP4 playback may need tail metadata before it can begin; test fast-start and
  non-fast-start files. Range transport does not fix unsupported codecs.
- Propose a host media component for mobile exposing play/pause, seek, duration,
  current time, errors, mute/volume where supported, and lifecycle cleanup.
  Host supplies native modules; adding `expo-video` to the plugin is insufficient.
- Switch video/audio and large original downloads to the source once supported.
  Keep the capped Blob path for older hosts and expose clear capability-based UI.
  No transcoding or background playback in the first release.

Acceptance: playback before full transfer, bounded memory, forward/backward seek,
relay operation, disconnect/reconnect, expired authorization, file replacement,
native background/interruption/navigation cleanup and unsupported codecs.

## Release checks

Each implementation should include its focused behavior tests, typechecking and
the existing suite. Exercise actual browser/desktop/mobile behavior where APIs
touch playback, downloads, keyboard focus or persistence. Run Paseo's real plugin
compiler and Hermes checks when their environment is available; report skipped
checks explicitly. Update OVERVIEW.md and manifest descriptions only for shipped
capabilities. Keep host-dependent features gated on actual capability support.
