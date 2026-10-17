# Adversarial implementation review

Reviewed the branch's actual code after implementation, against the product
review and roadmap. This was a deliberate second pass by the implementing agent,
not an independent external audit.

## Findings addressed and invariants verified

| Severity | Finding | Resolution and evidence |
| --- | --- | --- |
| High | Dense search results could be lost if a cursor advanced only between pages/windows. | Resume within the item and character offset; 309 dense cell matches are returned exactly once across batches. |
| High | Different spreadsheet column windows can have different row lengths when response budgets truncate them, skipping rows. | Search uses fixed eight-row/50-column windows that fit even worst-case JSON escaping. Regression covers nine rows across 52 densely escaped columns without duplicates or omissions. Normal viewing retains 200-row windows. |
| Medium | An entry-count cap alone could produce a saved-state file larger than its 1 MiB read limit. | Bound serialized bytes as well as 500 entries; regression verifies heavily escaped sheet names remain readable after saving. |
| Medium | Slow/failed state reads could block the viewer or allow default positions to overwrite unread history. | Hydration falls back after 1.5 seconds; late responses are ignored and failed/timed-out loads do not enable writes. Browser regression checks navigation remains intact and no position is written after a late response. |
| Medium | Async search responses or prepared downloads could arrive after a new query, cancellation, or document switch. | Generation guards, cleanup and document identity keys; browser regressions exercise query changes and cancelled preparation. |
| Medium | A changed file could splice original bytes from multiple versions. | Original downloads validate descriptor/path revision before and after each bounded read. Media rejects changing revision, MIME, size and invalid/non-advancing ranges. Tests cover rewritten originals and invalid transfers. |
| Medium | Finite search bursts and Stop could imply a completed zero-match search. | Explicit partial counts, Search more and stopped/error text; cap display at 500 with a narrowing hint. |
| Low | Viewer state could leak across files when a component type was reused. | Key every viewer and the persistent-state owner by workspace/path. Word resets its search anchor after revision changes. |
| Low | Audio reused video-only names and ambiguous failures. | Generalize the viewer and element names to MediaViewer/MediaElement; retain native playback gating and expose decoder errors. |
| Low | Ctrl/Cmd+F could capture another surface's shortcut. | Handle the event only inside the focused viewer, and only for searchable formats; browser test checks focus and opening. |

## Second review (Opus, after publication)

| Severity | Finding | Resolution and evidence |
| --- | --- | --- |
| Medium | Opening a FIFO for download blocked a daemon threadpool thread until a writer appeared; four requests stalled all daemon file I/O. | Open with `O_NONBLOCK` and reject non-regular files from `fstat`. Unit test fails against the previous code. |
| Medium | The focusable Find wrapper took keyboard focus on click, so PageDown/arrows/Space stopped scrolling, and it added an unlabeled tab stop. | The wrapper is no longer focusable; a click focuses the scroll area under the pointer. Browser check presses PageDown after a click and fails against the previous wrapper. |
| Medium | The header button polled every workspace every 5 seconds, just past the 4-second server scan reuse window, and retried failures without backoff. | Poll every 30 seconds; failures back off to 5 minutes. Unit tests cover both. |
| Test | The stale-query and late-position-read browser checks passed with their guards removed. | Stale query asserts no result rows after the full stale burst; late read asserts no position writes. Both fail with their guards removed. |
| Test | The shim ignored `ScrollView` `onLayout`, so PDF page images never rendered, and rendered `Pressable` as `<button>` instead of React Native Web's `div role=button`. | Shim fixed; page image and keyboard scrolling now exercised. |

## Remaining limitations / review focus

- Browser checks use real plugin React components and RPC handlers with a test
  DOM adapter. They are not tests of Paseo's React Native Web integration. Actual
  Paseo desktop save behavior and phone layout/gestures require host smoke tests.
- Full native media controls, native save/share, direct file-tree registration
  and progressive transport are absent from the pinned SDK. Proposals are in
  host-api-proposals.md; no fake or speculative host integration was shipped.
- Remembering Word scrolling/media time is deferred. Word search opens a reading
  segment at the matching block with a Show from beginning action.
- Search covers bounded extracted text, not OCR, hidden content, comments or
  complete Office layout. Results explicitly report coverage limitations. Very
  large streamed workbooks/Word files can be slow because existing readers may
  revisit earlier content; Search more/Stop bound requested work, not an already
  executing server RPC. A dedicated streaming index would be follow-up work.
- Search returns at most 50 matches per RPC, requests up to 20 batches per burst,
  and displays at most 500 results. Literal matching is non-overlapping and uses
  Unicode-aware case-insensitive matching. No user regex syntax is evaluated.
- Positions are host-shared, best-effort metadata. One daemon process serializes
  writes. Separate daemon processes under the same OS account should use isolated
  state directories before enabling simultaneous history writers; a cross-process
  storage lock is not implemented. Set PASEO_DOC_VIEWER_STATE_DIR to a distinct
  absolute directory for each such daemon.
- Media still loads completely before playback (256 MiB cap), and original
  preparation holds up to 128 MiB of data in memory. Cancellation ignores pending
  results and stops future requests; the pinned RPC API cannot abort server work.
- Synthetic WAV/WebM fixtures validate decoder progress and an unmuted video audio
  track; headless execution does not verify a physical speaker/output device.
- The existing bounded workspace scan can miss files beyond its scan budget.
  The header reflects supported files found by that scan; panel/commands remain
  available even when the header is hidden.

No known failing automated checks remain at the recorded verification point.
