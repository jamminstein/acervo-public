import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const audioSafetyProfile = 2;
export const loudnessTarget = -16;
export const integratedCeiling = -15;
export const truePeakCeiling = -0.5;
export const momentaryCeiling = -9;
export const shortTermCeiling = -10.5;

function lastNumber(text, expression) {
  return [...text.matchAll(expression)].map((match) => Number(match[1])).filter(Number.isFinite).at(-1);
}

export async function analyzeAudioSafety(mediaPath) {
  let stderr;
  try {
    ({ stderr } = await run("ffmpeg", [
      "-nostdin", "-hide_banner", "-nostats",
      "-i", mediaPath,
      "-map", "0:a:0", "-vn",
      "-af", "ebur128=peak=true",
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
    truePeak: lastNumber(stderr, /True peak:\s*\n\s*Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g),
    maxMomentary: Math.max(...momentaryValues),
    maxShortTerm: Math.max(...shortTermValues),
  };
}

export function calculateSafetyGainDb(metrics) {
  const candidates = [0];
  if (Number.isFinite(metrics?.lufs)) candidates.push(integratedCeiling - metrics.lufs);
  if (Number.isFinite(metrics?.truePeak)) candidates.push(truePeakCeiling - metrics.truePeak);
  if (Number.isFinite(metrics?.maxMomentary)) candidates.push(momentaryCeiling - metrics.maxMomentary);
  if (Number.isFinite(metrics?.maxShortTerm)) candidates.push(shortTermCeiling - metrics.maxShortTerm);
  return Math.round(Math.max(-8, Math.min(...candidates)) * 100) / 100;
}

export function hasSafetyMetrics(clip) {
  return Number.isFinite(clip?.lufs)
    && Number.isFinite(clip.truePeak)
    && Number.isFinite(clip.maxMomentary)
    && Number.isFinite(clip.maxShortTerm);
}

export function hasCurrentSafetyAnalysis(clip) {
  return hasSafetyMetrics(clip)
    && clip.safetyProfile === audioSafetyProfile
    && Number.isFinite(clip.safetyGainDb);
}
