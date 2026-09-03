import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, "index.html"), "utf8");
const app = readFileSync(join(root, "app.js"), "utf8");
const styles = readFileSync(join(root, "styles.css"), "utf8");
const sync = readFileSync(join(root, "scripts", "sync-from-acervo.mjs"), "utf8");
const clips = JSON.parse(readFileSync(join(root, "clips.json"), "utf8"));

assert.ok(clips.length > 0, "the page needs at least one public clip");
assert.match(html, /id="clips"/);
assert.match(html, /app\.js\?v=[a-z0-9-]+/, "the player needs a cache-busting version");
assert.match(html, /viewport-fit=cover/);
assert.doesNotMatch(html, /<h[1-6]|<p\b|<header\b/i, "the archive itself must remain visually minimal");
assert.match(html, /class="tiago-portal-nav"/, "the shared site navigation must be preserved");
assert.match(styles, /safe-area-inset-top/);
assert.match(styles, /touch-action: manipulation/);
assert.match(styles, /100dvh/);
assert.match(app, /webkit-playsinline/);
assert.doesNotMatch(app, /IntersectionObserver/, "inactive clips must remain static");
assert.doesNotMatch(app, /visibleTiles|previewLimit/, "the grid must not autoplay multiple videos");
assert.match(app, /stopPreview\(activeTile, true\)/);
assert.match(app, /new MediaMetadata/);
assert.match(app, /mediaSession\.setActionHandler/);
assert.match(app, /setPositionState/);
assert.doesNotMatch(app, /AudioContext|createMediaElementSource|createDynamicsCompressor/, "playback must stay on the CarPlay-compatible native media path");
assert.match(app, /gainFromDecibels/);
assert.match(app, /tile\.dataset\.audioSrc \|\| tile\.dataset\.src/);
assert.match(app, /clip\.safetyGainDb/);
assert.match(app, /shuffleQueue/);
assert.match(app, /randomizedClips = shuffle\(clips\)/);
assert.match(app, /playNext/);
assert.match(app, /audioPlayer\.addEventListener\("ended"/);
assert.doesNotMatch(app, /document\.hidden && activeTile/, "backgrounding must not stop the soundtrack");
assert.match(html, /id="transport"/);
assert.doesNotMatch(html, /playlist-indicator|Shuffled continuous playlist/, "shuffle is implicit, not a control");
assert.match(html, /id="waveform"/);
assert.match(app, /drawWaveform/);
assert.match(app, /clip\.waveform/);
assert.match(app, /waveformContext\.fill\(shape\)/);
assert.doesNotMatch(app, /barWidth/, "the waveform must be a continuous shape, not traces");
assert.match(styles, /\.tile-play/);
assert.match(sync, /master-public-audio\.mjs/);
assert.match(sync, /"-map", "0:v:0", "-an"/);

let publishedBytes = statSync(join(root, "index.html")).size
  + statSync(join(root, "app.js")).size
  + statSync(join(root, "styles.css")).size
  + statSync(join(root, "clips.json")).size;

for (const clip of clips) {
  const video = join(root, "media", `${clip.id}.mp4`);
  const poster = join(root, "posters", `${clip.id}.jpg`);
  const audio = join(root, "audio", `${clip.id}.m4a`);
  assert.ok(existsSync(video) && statSync(video).size > 0, `missing video ${clip.id}`);
  assert.ok(existsSync(poster) && statSync(poster).size > 0, `missing poster ${clip.id}`);
  assert.ok(existsSync(audio) && statSync(audio).size > 0, `missing mastered audio ${clip.id}`);
  assert.ok(statSync(video).size < 100 * 1024 * 1024, `video ${clip.id} exceeds GitHub's file limit`);
  assert.equal(clip.gainDb, 0, `clip ${clip.id} must not need live gain correction`);
  assert.equal(clip.safetyGainDb, 0, `clip ${clip.id} must not need live safety correction`);
  assert.equal(clip.safetyProfile, 7, `outdated audio safety analysis for ${clip.id}`);
  assert.ok(Number.isFinite(clip.maxMomentary) && Number.isFinite(clip.maxShortTerm), `missing perceived-loudness analysis for ${clip.id}`);
  assert.equal(Buffer.from(clip.waveform || "", "base64").length, 96, `invalid waveform for ${clip.id}`);
  assert.equal(clip.audioProfile, 7, `outdated mastered audio for ${clip.id}`);
  assert.equal(clip.audioProfileName, "car-consistent-v1", `wrong mastering profile for ${clip.id}`);
  assert.ok(clip.audioLufs >= -17 && clip.audioLufs <= -15, `uneven integrated loudness for ${clip.id}`);
  assert.ok(clip.audioLra <= 10 || clip.audioMaxMomentary <= -11.5, `uncontrolled loudness range for ${clip.id}`);
  assert.ok(clip.audioTruePeak <= -0.5, `unsafe true peak for ${clip.id}`);
  assert.ok(clip.audioMaxMomentary <= -9.5, `unsafe momentary loudness for ${clip.id}`);
  assert.ok(clip.audioMaxShortTerm <= -11, `unsafe short-term loudness for ${clip.id}`);

  const streams = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", video,
  ], { encoding: "utf8" })).streams || [];
  assert.ok(!streams.some((stream) => stream.codec_type === "audio"), `video ${clip.id} still duplicates its old audio`);
  publishedBytes += statSync(video).size + statSync(poster).size + statSync(audio).size;
}

assert.ok(publishedBytes < 1_000_000_000, `published site is ${(publishedBytes / 1_000_000).toFixed(1)} MB and exceeds GitHub Pages' 1 GB limit`);

console.log(`Verified ${clips.length} public clips and ${(publishedBytes / 1_000_000).toFixed(1)} MB of published media.`);
