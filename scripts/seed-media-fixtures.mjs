import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const destination = process.argv[2];
if (!destination) {
  console.error("Usage: node scripts/seed-media-fixtures.mjs <destination-directory>");
  process.exit(1);
}
const target = resolve(destination);
const scratch = mkdtempSync(join(tmpdir(), "viewer-media-fixtures-"));
const descriptions = {
  "landscape-with-sound.mp4": "H.264/AAC, landscape, moving test pattern and a 440 Hz tone",
  "portrait-with-sound.mp4": "H.264/AAC, portrait, moving test pattern and a 440 Hz tone",
  "quicktime-with-sound.mov": "H.264/AAC in a QuickTime container",
  "apple-with-sound.m4v": "H.264/AAC in an M4V container",
  "webm-with-sound.webm": "VP8/Opus, moving test pattern and a 440 Hz tone",
  "tone.wav": "PCM WAV, 440 Hz",
  "tone.mp3": "MP3, 440 Hz",
  "tone.m4a": "AAC in an M4A container, 440 Hz",
  "tone.flac": "FLAC, 440 Hz",
};

try {
  const missing = Object.keys(descriptions).filter((name) => !existsSync(join(target, name)));
  if (missing.length) {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    const make = (name, args) => {
      execFileSync("ffmpeg", ["-nostdin", "-y", "-loglevel", "error", ...args, "-threads", "1", join(scratch, name)], { stdio: "inherit" });
    };
    const sound = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=5"];
    const video = (size) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=24:duration=5`, ...sound];
    const h264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"];
    make("landscape-with-sound.mp4", [...video("320x180"), ...h264, "-movflags", "+faststart"]);
    if (missing.includes("portrait-with-sound.mp4")) make("portrait-with-sound.mp4", [...video("180x320"), ...h264, "-movflags", "+faststart"]);
    if (missing.includes("quicktime-with-sound.mov")) make("quicktime-with-sound.mov", ["-i", join(scratch, "landscape-with-sound.mp4"), "-c", "copy", "-f", "mov"]);
    if (missing.includes("apple-with-sound.m4v")) make("apple-with-sound.m4v", ["-i", join(scratch, "landscape-with-sound.mp4"), "-c", "copy", "-f", "ipod"]);
    if (missing.includes("webm-with-sound.webm")) make("webm-with-sound.webm", [...video("320x180"), "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-shortest"]);
    for (const [name, codec] of [["tone.wav", "pcm_s16le"], ["tone.mp3", "libmp3lame"], ["tone.m4a", "aac"], ["tone.flac", "flac"]]) {
      if (missing.includes(name)) make(name, [...sound, "-c:a", codec]);
    }
    mkdirSync(target, { recursive: true });
    for (const name of missing) copyFileSync(join(scratch, name), join(target, name), constants.COPYFILE_EXCL);
  }
  const guide = "# Media test samples\n\nGenerated synthetic five-second clips and tones. No external media.\n\n" +
    Object.entries(descriptions).map(([name, description]) => `- ${name}: ${description}.`).join("\n") +
    "\n\nIn Paseo's Documents panel, select Video or Audio. Video playback is currently available on web/desktop; the native app shows the availability message. Native audio uses Play audio when the host provides it. Codec support varies by client.\n";
  if (!existsSync(join(target, "README.md"))) writeFileSync(join(target, "README.md"), guide, { flag: "wx" });
  console.log(`Media samples ready in ${target}: ${Object.keys(descriptions).length} files (existing files preserved).`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
