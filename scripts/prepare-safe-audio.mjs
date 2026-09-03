import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { analyzeAudioSafety, calculateSafetyGainDb } from "./audio-safety.mjs";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clipsFile = join(root, "clips.json");
const audioDir = join(root, "audio");
const audioProfile = 4;
const bakedThresholdDb = -0.5;
const clips = JSON.parse(readFileSync(clipsFile, "utf8"));
const selected = new Set(clips.filter((clip) => clip.safetyGainDb <= bakedThresholdDb).map((clip) => String(clip.id)));

mkdirSync(audioDir, { recursive: true });
for (const name of readdirSync(audioDir)) {
  const id = name.endsWith(".m4a") ? name.slice(0, -4) : "";
  if (/^\d+$/.test(id) && !selected.has(id)) rmSync(join(audioDir, name));
}

let cursor = 0;
let finished = 0;

async function renderAudio(clip, destination, gainDb) {
  const temporary = join(audioDir, `.${clip.id}.tmp.m4a`);
  await run("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", join(root, "media", `${clip.id}.mp4`),
    "-map", "0:a:0", "-vn",
    "-af", `volume=${gainDb}dB,alimiter=limit=0.501187:attack=5:release=80:level=false:latency=true`,
    "-c:a", "aac", "-b:a", "64k", "-ar", "48000",
    "-movflags", "+faststart",
    "-metadata", "comment=ACERVO safety-normalized web audio; source preserved",
    "-y", temporary,
  ], { maxBuffer: 8 * 1024 * 1024 });
  renameSync(temporary, destination);
}

async function prepareClip(clip) {
  const destination = join(audioDir, `${clip.id}.m4a`);
  const canReuse = existsSync(destination)
    && clip.audioProfile === audioProfile
    && clip.audioSourceRev === clip.rev
    && Number.isFinite(clip.audioRev)
    && Number.isFinite(clip.bakedGainDb);

  if (!canReuse) {
    let bakedGainDb = clip.safetyGainDb;
    await renderAudio(clip, destination, bakedGainDb);
    let metrics = await analyzeAudioSafety(destination);
    const residualGainDb = calculateSafetyGainDb(metrics);
    if (residualGainDb <= bakedThresholdDb) {
      bakedGainDb = Math.round((bakedGainDb + residualGainDb) * 100) / 100;
      await renderAudio(clip, destination, bakedGainDb);
      metrics = await analyzeAudioSafety(destination);
    }

    Object.assign(clip, {
      audioProfile,
      audioSourceRev: clip.rev,
      audioRev: Math.floor(statSync(destination).mtimeMs),
      bakedGainDb,
      audioLufs: metrics.lufs,
      audioTruePeak: metrics.truePeak,
      audioMaxMomentary: metrics.maxMomentary,
      audioMaxShortTerm: metrics.maxShortTerm,
    });
  }
}

async function worker() {
  while (cursor < clips.length) {
    const clip = clips[cursor++];
    if (selected.has(String(clip.id))) await prepareClip(clip);
    else {
      delete clip.audioProfile;
      delete clip.audioSourceRev;
      delete clip.audioRev;
      delete clip.bakedGainDb;
      delete clip.audioLufs;
      delete clip.audioTruePeak;
      delete clip.audioMaxMomentary;
      delete clip.audioMaxShortTerm;
    }
    finished += 1;
    if (finished % 25 === 0 || finished === clips.length) {
      process.stdout.write(`\rPrepared ${finished}/${clips.length} playback tracks`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(4, clips.length) }, () => worker()));
writeFileSync(clipsFile, `${JSON.stringify(clips, null, 2)}\n`);
process.stdout.write("\n");
