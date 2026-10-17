# Paseo host API proposals

These are proposed host changes, not plugin capabilities. Nothing has been
published upstream. The viewer continues to work with SDK 0.11.2.

## Open with Document Viewer

Proposed registration:

```ts
client.addFileOpenHandler({
  id: "document-viewer",
  title: "Document Viewer",
  extensions: ["pdf", "docx", "xlsx", "csv", "tsv", "pptx", "mp4", "mp3", "wav"],
  onOpen: ({ workspaceId, path, openScreen }) =>
    openScreen({ screenId: "document", params: { workspaceId, path } }),
});
```

The host owns the Open with menu and user-configured default. Default file clicks
retain existing behavior until the user chooses this handler. Resolve multiple
handlers explicitly, target the correct daemon, release registrations on plugin
unload, and provide a capability check for older hosts. The server still enforces
workspace confinement. Add host tests for competing handlers, deleted files,
workspace changes, plugin reload and mobile navigation.

## Save/share a workspace original

A host action accepts workspace/path, display filename, expected revision and
abort signal; the host selects a native save dialog or mobile share sheet and
copies bytes through existing authenticated transport with progress. It returns
completed/cancelled rather than interpreting a cancelled picker as an error.

Do not pass whole files as base64 across the UI bridge. Check revision before and
during transfer; never export a mixture of revisions. A save destination must
not be supplied as an arbitrary daemon path. Preserve original encryption and
format. Test picker cancellation, low disk space, relay interruption, confinement,
filename handling and files larger than in-memory Blob limits.

## Seekable media source and native player

A proposed `openWorkspaceMedia` capability resolves an authenticated source from
workspace/path/revision with MIME, byte length, expiry and an explicit release
method. Its representation must be usable by browser and native players without
exposing daemon credentials. Agree the transport before choosing a URL scheme:
ordinary custom RPC callbacks cannot be used as HTML media sources.

The source must work over direct and relay/encrypted connections, allow bounded
random reads, and support seeking without full-file assembly. If HTTP is used,
implement Range/If-Range, 200/206/416, correct MIME/length, ETag tied to revision,
origin/authentication handling, expiry and revocation. Preserve Blob fallback on
older hosts. Test fast-start and tail-index MP4, unsupported codecs, replaced
files, expiring credentials, reconnect and bounded memory.

Expose a host-supplied media component with kind, source, playback state,
play/pause, current time, seek, duration, errors, mute/volume where available, and
lifecycle stop/release. The host bundles native modules; plugin npm dependencies
cannot add them. Define screen-unmount, interruption and app-background behavior.
Do not enable background playback by accident. Test audio and video on iOS and
Android, including physical devices and silent-mode behavior.

The current SDK `playAudio` helper does not expose pause/seek/per-playback stop;
it is insufficient for a full document-media player.
