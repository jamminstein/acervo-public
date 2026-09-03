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
import {
  analyzeAudioSafety,
  calculateSafetyGainDb,
  loudnessTarget,
  momentaryCeiling,
  shortTermCeiling,
} from "./audio-safety.mjs";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clipsFile = join(root, "clips.json");
const audioDir = join(root, "audio");
const audioProfile = 6;
const bakedThresholdDb = -0.5;
const clips = JSON.parse(readFileSync(clipsFile, "utf8"));
const selected = new Set(
  clips
    .filter((clip) => clip.safetyGainDb <= bakedThresholdDb || clip.lufs < -18)
    .map((clip) => String(clip.id)),
);

function recommendedBakedGainDb(clip) {
  const gainDb = Math.min(
    loudnessTarget - clip.lufs,
    momentaryCeiling - clip.maxMomentary,
    shortTermCeiling - clip.maxShortTerm,
  );
  return Math.round(Math.max(-8, Math.min(6, gainDb)) * 100) / 100;
}

mkdirSync(audioDir, { recursive: true });
for (const name of readdirSync(audioDir)) {
  const id = name.endsWith(".m4a") ? name.slice(0, -4) : "";
  if (/^\d+$/.test(id) && !selected.has(id)) rmSync(join(audioDir, name));
}

let cursor = 0;
let finished = 0;

async function renderAudio(clip, destination, gainDb, limiterLevel) {
  const temporary = join(audioDir, `.${clip.id}.tmp.m4a`);
  await run("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", join(root, "media", `${clip.id}.mp4`),
    "-map", "0:a:0", "-vn",
    "-af", `volume=${gainDb}dB,alimiter=limit=${limiterLevel}:attack=5:release=80:level=false:latency=true`,
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
    let bakedGainDb = recommendedBakedGainDb(clip);
    let limiterLevel = 0.501187;
    let metrics;
    for (let pass = 0; pass < 4; pass += 1) {
      await renderAudio(clip, destination, bakedGainDb, limiterLevel);
      metrics = await analyzeAudioSafety(destination);
      const safetyCorrectionDb = calculateSafetyGainDb(metrics);
      if (safetyCorrectionDb < -0.1) {
        bakedGainDb = Math.round((bakedGainDb + safetyCorrectionDb) * 100) / 100;
        limiterLevel = 0.316228;
        continue;
      }

      if (metrics.lufs < -18) {
        const quietCorrectionDb = Math.min(
          -17 - metrics.lufs,
          momentaryCeiling - metrics.maxMomentary,
          shortTermCeiling - metrics.maxShortTerm,
          3,
        );
        if (quietCorrectionDb > 0.1) {
          bakedGainDb = Math.round((bakedGainDb + quietCorrectionDb) * 100) / 100;
          continue;
        }
      }
      break;
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
