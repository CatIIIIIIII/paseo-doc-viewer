# Audio support: feasibility and implementation plan

Reviewed against doc-viewer a5924d6 and its pinned @getpaseo/plugin 0.11.2 SDK.
No audio implementation is included in this change.

## Existing video sound

Desktop and web already render an HTML `video` element with native controls
(`client/web.ts`). It is not muted. `server/media.ts` sends original file bytes,
including the audio track, without transcoding. Supported audio tracks should
therefore play today. A silent video needs reproduction with its actual codecs,
browser or desktop runtime, mute state and output device before changing code.

The transfer is chunked RPC, but `client/media.ts` assembles the entire file into
a Blob before playback. It is not progressive streaming. Playback is capped at
256 MiB; loading is automatic up to 32 MiB. Container extensions alone do not
guarantee that the browser can decode the video and audio codecs inside them.

## Standalone audio

Feasible without a new daemon dependency for formats the playback device decodes.

1. Add an `audio` kind in `shared/kinds.ts`, with format-aware header validation
   and the `media.chunk` capability. Begin with MP3, M4A, WAV and FLAC; expand to
   AAC, Ogg and WebM audio after platform tests. Validate WAV's RIFF/WAVE header
   rather than accepting arbitrary RIFF files. MP3 needs ID3 and frame-header
   handling; ISO-BMFF and Ogg containers need appropriate container checks.
2. Add audio MIME mappings and a handler in `server/documents.ts`. Extend both
   `doc.open` and `media.chunk` RPC output schemas. Reuse workspace confinement,
   revision handling, bounded chunks and the existing file assembly code.
3. Extend browse groups, icon/label maps, empty-state descriptions and command
   keywords. Audio then participates in search, counts and icon visibility.
4. Generalize `VideoViewer` to share loading, retries, limits and URL cleanup.
   Render HTML `audio controls` for audio on desktop/web. Keep autoplay off and
   show a useful decoder-error message; receiving bytes is not playback success.
5. Add native audio separately through SDK `client.playAudio({ base64, mimeType })`,
   passed to the screen through its registration closure. `encodeBase64` already
   exists. This provides basic play-to-completion only: the public API exposes
   no pause, seek, progress, per-playback stop or cancellation signal. Use a
   smaller native file cap to account for simultaneous bytes and base64 copies;
   do not present controls that the API cannot implement.
6. Test kind detection, schema validation, byte-exact chunk loading, audio-only
   workspaces, revised files and URL cleanup. Manually verify audible video and
   audio with fixtures containing known audio tracks, including an unsupported
   codec case, on desktop, browsers, iOS and Android. Check leaving the screen
   during native playback since screen-local stop is unavailable.

## Mobile video and richer playback

Mobile video is deliberately gated off in `client/video-viewer.tsx`. The pinned
SDK exposes no video component. Paseo's current native host implements file audio
with `expo-audio`, but its plugin module allowlist does not expose `expo-audio`
or `expo-video`; installing either in this plugin does not make native modules
available. References in the host repository: `packages/app/src/plugins/evaluate.ts`,
`packages/app/src/plugins/client-runtime.ts`, and
`packages/app/src/audio/audio-engine.native.ts`.

A full mobile audio/video player needs a host-exposed media component or expanded
playback API, plus a compatible SDK requirement. True progressive playback of
large files would also need a seekable source, such as an authenticated range
endpoint that works through Paseo's relay, rather than the current full-file Blob.
Neither change is necessary for an initial desktop/web audio player.

Recommended order: verify existing video sound, ship desktop/web audio, decide
whether basic native audio is useful, then pursue host support for full native
media controls. Retain the current transfer model initially.
