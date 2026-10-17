# Adversarial product review (before implementation)

Question: does each feature reduce real friction without making this small viewer
unreliable or surprising?

| Proposal | Challenge | Decision |
| --- | --- | --- |
| Conditional icon | Hiding discovery can confuse users; an incomplete scan is not proof of no files. Polling every workspace also has a cost. | Keep the panel/commands always available; header follows supported files found by the existing bounded scan. Reuse its cache and avoid overlapping polls. |
| Remember position | Restoring stale anchors or persisting passwords would be worse than starting over. Automatically resuming audio is surprising. Shared history is not device-private. | First implement stable page/zoom and sheet-window state, with reset, bounded retention and best-effort persistence. Never resume playback automatically. Defer Word anchors until block identity is reliable. State is shared by clients of this daemon and documented. |
| Audio | A Play button that cannot pause/stop on mobile is a poor long-form player. Codec/container support is not guaranteed. | Ship desktop/web native controls and useful decoder errors. Leave mobile disabled until host controls exist. Verify track bytes rather than promising universal codecs. |
| Find | Returning only the visible page or silently truncated cells would mislead users. Running an entire workbook search synchronously could freeze the daemon. | Incremental whole-file search with bounded batches, explicit coverage limits and result navigation. PDF image-coordinate highlighting is deferred; text-mode highlighting is the honest first version. |
| Download original | 'Export' implies format conversion. Async saving may lose browser user activation; desktop may differ. Downloading unbounded files can exhaust memory. | Label Download original. Use explicit Prepare, then Save, progress/cancel and a size cap. Gate on browser capabilities and call out desktop/native verification limits. No conversion. |
| Open from tree | A plugin cannot manufacture host extension points. Hijacking all file clicks would be intrusive. | Write an Open with proposal; preserve normal file handling. Do not ship a fake integration. |
| Progressive media | Chunking RPC is not progressive playback. A bespoke public HTTP server would break the relay/authentication model. | Host API proposal with authenticated seekable sources, range support and lifecycle handling. Keep the capped Blob fallback. |

Delivery scope for this branch: conditional icon; stable reading positions;
desktop/web audio; bounded in-document search and navigation; browser original-file
saving; concrete host API proposals for the blocked features. Keep changes in
separate commits for review. No automatic publishing or upstream messages.

Validation must distinguish automated correctness from actual runtime checks.
Native playback, native save/share, and file-tree hooks remain explicitly blocked.
