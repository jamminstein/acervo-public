import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeAudioSafety,
  audioSafetyProfile,
  calculateSafetyGainDb,
  hasCurrentSafetyAnalysis,
  hasSafetyMetrics,
  loudnessTarget,
} from "./audio-safety.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clipsFile = join(root, "clips.json");
const clips = JSON.parse(readFileSync(clipsFile, "utf8"));
let cursor = 0;
let finished = 0;

async function worker() {
  while (cursor < clips.length) {
    const clip = clips[cursor++];
    if (!hasCurrentSafetyAnalysis(clip)) {
      const metrics = hasSafetyMetrics(clip)
        ? clip
        : await analyzeAudioSafety(join(root, "media", `${clip.id}.mp4`));
      if (metrics) {
        Object.assign(clip, metrics, {
          gainDb: Math.round(Math.max(-6, Math.min(6, loudnessTarget - metrics.lufs)) * 100) / 100,
          safetyGainDb: calculateSafetyGainDb(metrics),
          safetyProfile: audioSafetyProfile,
        });
      }
    }
    finished += 1;
    if (finished % 25 === 0 || finished === clips.length) {
      process.stdout.write(`\rAnalyzed ${finished}/${clips.length} public clips`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(8, clips.length) }, () => worker()));
writeFileSync(clipsFile, `${JSON.stringify(clips, null, 2)}\n`);
process.stdout.write("\n");
