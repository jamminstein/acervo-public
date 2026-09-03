import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
function lastNumber(text, expression) {
  return [...text.matchAll(expression)].map((match) => Number(match[1])).filter(Number.isFinite).at(-1);
}

export async function analyzeAudioSafety(mediaPath, preFilter = "") {
  let stderr;
  try {
    ({ stderr } = await run("ffmpeg", [
      "-nostdin", "-hide_banner", "-nostats",
      "-i", mediaPath,
      "-map", "0:a:0", "-vn",
      "-af", `${preFilter ? `${preFilter},` : ""}ebur128=peak=true`,
      "-f", "null", "-",
    ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (/matches no streams|does not contain any stream/i.test(message)) return null;
    throw error;
  }

  const momentaryValues = [...stderr.matchAll(/\bM:\s*(-?\d+(?:\.\d+)?)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  const shortTermValues = [...stderr.matchAll(/\bS:\s*(-?\d+(?:\.\d+)?)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);

  return {
    lufs: lastNumber(stderr, /Integrated loudness:\s*\n\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g),
    lra: lastNumber(stderr, /Loudness range:\s*\n\s*LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/g),
    truePeak: lastNumber(stderr, /True peak:\s*\n\s*Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g),
    maxMomentary: Math.max(...momentaryValues),
    maxShortTerm: Math.max(...shortTermValues),
  };
}
