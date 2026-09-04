import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, "index.html"), "utf8");
const app = readFileSync(join(root, "app.js"), "utf8");
const styles = readFileSync(join(root, "styles.css"), "utf8");
const sync = readFileSync(join(root, "scripts", "sync-from-acervo.mjs"), "utf8");
const clips = JSON.parse(readFileSync(join(root, "clips.json"), "utf8"));
const audioRoots = [
  resolve(root, "..", "acervo-public-audio"),
  resolve(root, "..", "acervo-public-audio-2"),
];

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
assert.match(app, /https:\/\/jamminstein\.github\.io\/acervo-public-audio/);
assert.match(app, /https:\/\/jamminstein\.github\.io\/acervo-public-audio-2/);
assert.doesNotMatch(app, /function prefetchNextAudio/, "mobile playback must not compete with full-file prefetches");
assert.match(app, /clip\.safetyGainDb/);
assert.match(app, /shuffleQueue/);
assert.match(app, /randomizedClips = shuffle\(clips\)/);
assert.match(app, /playNext/);
assert.match(app, /audioPlayer\.addEventListener\("ended"/);
assert.match(app, /playbackRequestId/);
assert.match(app, /nextTransitionActive/);
assert.match(app, /manualNextAllowedAt/);
assert.match(app, /audioPlayer\.currentSrc !== activeAudioUrl/);
assert.match(app, /tile\.dataset\.clipId/);
assert.doesNotMatch(app, /playNext\(failedTile\)/, "failed or interrupted play attempts must not create skip cascades");
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
const audioBytes = [0, 0];
const selected = new Map(clips.map((clip) => [String(clip.id), clip]));

for (const clip of clips) {
  const video = join(root, "media", `${clip.id}.mp4`);
  const poster = join(root, "posters", `${clip.id}.jpg`);
  assert.ok(clip.audioShard === 1 || clip.audioShard === 2, `invalid audio shard for ${clip.id}`);
  const audio = join(audioRoots[clip.audioShard - 1], `${clip.id}.m4a`);
  assert.ok(existsSync(video) && statSync(video).size > 0, `missing video ${clip.id}`);
  assert.ok(existsSync(poster) && statSync(poster).size > 0, `missing poster ${clip.id}`);
  assert.ok(existsSync(audio) && statSync(audio).size > 0, `missing mastered audio ${clip.id}`);
  assert.ok(statSync(video).size < 100 * 1024 * 1024, `video ${clip.id} exceeds GitHub's file limit`);
  assert.ok(statSync(audio).size < 100 * 1024 * 1024, `audio ${clip.id} exceeds GitHub's file limit`);
  assert.equal(clip.gainDb, 0, `clip ${clip.id} must not need live gain correction`);
  assert.equal(clip.safetyGainDb, 0, `clip ${clip.id} must not need live safety correction`);
  assert.equal(clip.safetyProfile, 9, `outdated audio safety analysis for ${clip.id}`);
  assert.ok(Number.isFinite(clip.maxMomentary) && Number.isFinite(clip.maxShortTerm), `missing perceived-loudness analysis for ${clip.id}`);
  assert.equal(Buffer.from(clip.waveform || "", "base64").length, 96, `invalid waveform for ${clip.id}`);
  assert.equal(clip.audioProfile, 9, `outdated mastered audio for ${clip.id}`);
  assert.equal(clip.audioProfileName, "car-consistent-v3-tighter-dynamics", `wrong mastering profile for ${clip.id}`);
  assert.equal(clip.audioBitrateKbps, 96, `wrong AAC quality for ${clip.id}`);
  assert.match(clip.audioSourceSignature, /^archive:/, `clip ${clip.id} was not mastered from its original`);
  assert.equal(clip.sourceProfileVersion, 1, `missing source profile for ${clip.id}`);
  assert.ok(Number.isFinite(clip.sourceBassDelta) && Number.isFinite(clip.sourcePresenceDelta), `missing tonal profile for ${clip.id}`);
  assert.ok(Number.isFinite(clip.sourceChannelImbalance) && Number.isFinite(clip.sourceMonoDelta), `missing channel profile for ${clip.id}`);
  assert.ok(Number.isFinite(clip.audioIntroRms), `missing opening-noise analysis for ${clip.id}`);
  assert.ok(clip.audioGateThresholdDb <= -38, `unsafe gate threshold for ${clip.id}`);
  assert.ok(clip.audioCompressorThresholdDb <= -18, `invalid compressor threshold for ${clip.id}`);
  assert.ok(clip.audioOutputPadDb <= -1.5, `missing codec peak safety margin for ${clip.id}`);
  assert.ok(clip.audioIntroRms <= clip.sourceIntroRms + clip.audioMasterGainDb + 1.5, `opening noise was raised unexpectedly for ${clip.id}`);
  assert.ok(clip.audioChannelMode === "stereo" || clip.audioChannelImbalance <= 1, `channel repair failed for ${clip.id}`);
  assert.ok(clip.audioLufs >= -17.5 && clip.audioLufs <= -15, `uneven integrated loudness for ${clip.id}`);
  assert.ok(clip.audioLra <= 8 || clip.audioMaxMomentary <= -13, `uncontrolled loudness range for ${clip.id}`);
  assert.ok(clip.audioTruePeak <= -1, `unsafe true peak for ${clip.id}`);
  assert.ok(clip.audioMaxMomentary <= -11.5, `unsafe momentary loudness for ${clip.id}`);
  assert.ok(clip.audioMaxShortTerm <= -13, `unsafe short-term loudness for ${clip.id}`);

  const streams = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", video,
  ], { encoding: "utf8" })).streams || [];
  assert.ok(!streams.some((stream) => stream.codec_type === "audio"), `video ${clip.id} still duplicates its old audio`);
  publishedBytes += statSync(video).size + statSync(poster).size;
  audioBytes[clip.audioShard - 1] += statSync(audio).size;
}

assert.ok(publishedBytes < 1_000_000_000, `published site is ${(publishedBytes / 1_000_000).toFixed(1)} MB and exceeds GitHub Pages' 1 GB limit`);
for (const [index, directory] of audioRoots.entries()) {
  for (const name of readdirSync(directory)) {
    const match = name.match(/^(\d+)\.m4a$/);
    if (!match) continue;
    const clip = selected.get(match[1]);
    assert.ok(clip && clip.audioShard === index + 1, `unexpected audio file ${name} in shard ${index + 1}`);
  }
  assert.ok(audioBytes[index] < 1_000_000_000, `published audio shard ${index + 1} is ${(audioBytes[index] / 1_000_000).toFixed(1)} MB and exceeds GitHub Pages' 1 GB limit`);
}

console.log(`Verified ${clips.length} public clips: ${(publishedBytes / 1_000_000).toFixed(1)} MB visual site; audio shards ${audioBytes.map((bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`).join(" + ")}.`);
