import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractWaveform, isValidWaveform } from "./waveforms.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clipsFile = join(root, "clips.json");
const clips = JSON.parse(readFileSync(clipsFile, "utf8"));
let cursor = 0;
let finished = 0;

async function worker() {
  while (cursor < clips.length) {
    const clip = clips[cursor++];
    if (!isValidWaveform(clip.waveform)) {
      clip.waveform = await extractWaveform(join(root, "media", `${clip.id}.mp4`));
    }
    finished += 1;
    process.stdout.write(`\rGenerated ${finished}/${clips.length} waveforms`);
  }
}

await Promise.all(Array.from({ length: Math.min(8, clips.length) }, () => worker()));
writeFileSync(clipsFile, `${JSON.stringify(clips, null, 2)}\n`);
process.stdout.write("\n");
