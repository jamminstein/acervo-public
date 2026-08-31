import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const waveformSampleCount = 96;

export function isValidWaveform(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    return Buffer.from(value, "base64").length === waveformSampleCount;
  } catch {
    return false;
  }
}

export async function extractWaveform(mediaPath) {
  let stdout;
  try {
    ({ stdout } = await run("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-i", mediaPath,
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "2000",
      "-f", "s16le", "pipe:1",
    ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (/matches no streams|does not contain any stream/i.test(message)) return null;
    throw error;
  }

  const sampleTotal = Math.floor(stdout.length / 2);
  if (!sampleTotal) return null;

  const levels = [];
  for (let bucket = 0; bucket < waveformSampleCount; bucket += 1) {
    const start = Math.floor((bucket * sampleTotal) / waveformSampleCount);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * sampleTotal) / waveformSampleCount));
    const stride = Math.max(1, Math.floor((end - start) / 384));
    let squares = 0;
    let count = 0;
    for (let sample = start; sample < end; sample += stride) {
      const normalized = stdout.readInt16LE(sample * 2) / 32768;
      squares += normalized * normalized;
      count += 1;
    }
    levels.push(Math.sqrt(squares / Math.max(1, count)));
  }

  const maximum = Math.max(...levels);
  if (!maximum) return Buffer.alloc(waveformSampleCount).toString("base64");
  const values = levels.map((level) => Math.max(1, Math.round((level / maximum) ** 0.65 * 255)));
  return Buffer.from(values).toString("base64");
}
