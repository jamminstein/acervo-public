import { execFile, execFileSync } from "node:child_process";
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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { analyzeAudioSafety } from "./audio-safety.mjs";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clipsFile = join(root, "clips.json");
const mediaDir = join(root, "media");
const audioDir = join(root, "audio");
const database = join(homedir(), "Library", "Application Support", "acervo", "acervo.db");

// This is deliberately baked into a normal AAC soundtrack. iOS and CarPlay can
// suspend Web Audio processing in the background, while a regular media track
// keeps using the system playback path.
export const masteringProfile = 7;
export const masteringProfileName = "car-consistent-v1";
const targetLufs = -16;
const hardQuietFloor = -17;
const hardLoudCeiling = -15;
const truePeakCeiling = -0.5;
const momentaryCeiling = -9.5;
const shortTermCeiling = -11;
// Preserve some intentional musical dynamics while preventing unusually wide
// clips from behaving like a different master in a noisy listening space.
const lraCeiling = 10;

const clips = JSON.parse(readFileSync(clipsFile, "utf8"));
const selected = new Set(clips.map((clip) => String(clip.id)));
mkdirSync(audioDir, { recursive: true });

function databaseSources() {
  if (!existsSync(database)) return new Map();
  const query = `
    SELECT id, path
    FROM items
    WHERE public=1 AND hidden=0 AND missing=0 AND kind='video'
  `;
  const rows = JSON.parse(execFileSync("sqlite3", ["-json", database, query], { encoding: "utf8" }) || "[]");
  return new Map(rows.map((row) => [String(row.id), row.path]));
}

const sourceById = databaseSources();

function probeStreams(path) {
  try {
    return JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", path,
    ], { encoding: "utf8" })).streams || [];
  } catch {
    return [];
  }
}

function hasAudio(path) {
  return existsSync(path) && probeStreams(path).some((stream) => stream.codec_type === "audio");
}

function sourceForClip(clip) {
  const archiveSource = sourceById.get(String(clip.id));
  if (archiveSource && hasAudio(archiveSource)) return { path: archiveSource, kind: "archive" };
  const webDerivative = join(mediaDir, `${clip.id}.mp4`);
  if (hasAudio(webDerivative)) return { path: webDerivative, kind: "web-derivative" };
  return null;
}

function sourceSignature(source) {
  const stats = statSync(source.path);
  return `${source.kind}:${stats.size}:${Math.floor(stats.mtimeMs)}`;
}

function dbToLinear(decibels) {
  return (10 ** (decibels / 20)).toFixed(6);
}

function masteringFilter({
  loudnessTarget,
  loudnessRange,
  compressorThreshold,
  compressorRatio,
  preLimiterDb,
  finalLimiterDb,
}) {
  return [
    "highpass=f=30:p=2",
    `acompressor=threshold=${compressorThreshold}:ratio=${compressorRatio}:attack=18:release=280:knee=4:makeup=1:link=average:detection=rms`,
    `alimiter=limit=${dbToLinear(preLimiterDb)}:attack=5:release=90:level=false:latency=true`,
    `loudnorm=I=${loudnessTarget}:LRA=${loudnessRange}:TP=-3:linear=false`,
    "aresample=48000",
    `alimiter=limit=${dbToLinear(finalLimiterDb)}:attack=5:release=100:level=false:latency=true`,
  ].join(",");
}

async function renderMaster(clip, source, destination, settings) {
  const temporary = join(audioDir, `.${clip.id}.mastering.m4a`);
  await run("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", source.path,
    "-map", "0:a:0", "-vn",
    "-af", masteringFilter(settings),
    "-c:a", "aac", "-b:a", `${settings.bitRateKbps}k`, "-ar", "48000",
    "-movflags", "+faststart",
    "-metadata", `comment=ACERVO ${masteringProfileName} master; source archive preserved`,
    "-y", temporary,
  ], { maxBuffer: 16 * 1024 * 1024 });
  renameSync(temporary, destination);
}

function metricsAreCurrent(clip) {
  return Number.isFinite(clip.audioLufs)
    && Number.isFinite(clip.audioLra)
    && Number.isFinite(clip.audioTruePeak)
    && Number.isFinite(clip.audioMaxMomentary)
    && Number.isFinite(clip.audioMaxShortTerm);
}

function withinTarget(metrics) {
  return metrics.lufs >= hardQuietFloor
    && metrics.lufs <= hardLoudCeiling
    && (metrics.lra <= lraCeiling || metrics.maxMomentary <= -11.5)
    && metrics.truePeak <= truePeakCeiling
    && metrics.maxMomentary <= momentaryCeiling
    && metrics.maxShortTerm <= shortTermCeiling;
}

let masterCursor = 0;
let masteredCount = 0;
let reusedCount = 0;

function saveClips() {
  const temporary = join(root, ".clips.json.mastering");
  writeFileSync(temporary, `${JSON.stringify(clips, null, 2)}\n`);
  renameSync(temporary, clipsFile);
}

async function masterClip(clip) {
  const destination = join(audioDir, `${clip.id}.m4a`);
  const reusableWithoutSource = existsSync(destination)
    && clip.audioProfile === masteringProfile
    && metricsAreCurrent(clip)
    && withinTarget({
      lufs: clip.audioLufs,
      lra: clip.audioLra,
      truePeak: clip.audioTruePeak,
      maxMomentary: clip.audioMaxMomentary,
      maxShortTerm: clip.audioMaxShortTerm,
    });
  const source = sourceForClip(clip);
  const signature = source ? sourceSignature(source) : null;
  const canReuse = reusableWithoutSource
    && (!source || clip.audioSourceSignature === signature);

  if (canReuse) {
    reusedCount += 1;
    return;
  }
  if (!source) throw new Error(`No usable audio source for public clip ${clip.id}`);

  const settings = {
    loudnessTarget: -16.2,
    loudnessRange: 4,
    compressorThreshold: 0.1,
    compressorRatio: 4,
    preLimiterDb: -8,
    finalLimiterDb: -5,
    bitRateKbps: 52,
  };
  let metrics;
  for (let pass = 0; pass < 10; pass += 1) {
    await renderMaster(clip, source, destination, settings);
    metrics = await analyzeAudioSafety(destination);
    if (withinTarget(metrics)) break;

    if (metrics.lra > lraCeiling && metrics.maxMomentary > -11.5) {
      settings.loudnessRange = Math.max(3, settings.loudnessRange - 0.5);
      settings.compressorThreshold = Math.max(0.063, settings.compressorThreshold * 0.8);
      settings.compressorRatio = Math.min(6, settings.compressorRatio + 1);
      continue;
    }

    if (metrics.truePeak > truePeakCeiling) {
      // A few especially bright sources create large inter-sample peaks when
      // encoded at a very small AAC bitrate. More codec headroom fixes those
      // without turning the whole musical body down.
      if (metrics.truePeak > 0.5 && settings.bitRateKbps < 96) settings.bitRateKbps = 96;
      else settings.finalLimiterDb = Math.max(-10, settings.finalLimiterDb - (metrics.truePeak - truePeakCeiling + 0.3));
      continue;
    }

    const safetyReduction = Math.min(
      0,
      momentaryCeiling - metrics.maxMomentary,
      shortTermCeiling - metrics.maxShortTerm,
    );
    if (safetyReduction < -0.1) {
      settings.loudnessTarget = Math.max(-19, settings.loudnessTarget + safetyReduction);
    } else if (metrics.lufs < hardQuietFloor) {
      settings.loudnessTarget = Math.min(-10, settings.loudnessTarget + Math.min(2, targetLufs - metrics.lufs));
      settings.preLimiterDb = Math.max(-14, settings.preLimiterDb - 1.5);
    } else if (metrics.lufs > hardLoudCeiling) {
      settings.loudnessTarget = Math.max(-19, settings.loudnessTarget + targetLufs - metrics.lufs);
    }
  }

  if (!withinTarget(metrics)) {
    throw new Error(`Master ${clip.id} missed the safety corridor: ${JSON.stringify(metrics)}`);
  }

  Object.assign(clip, {
    audioProfile: masteringProfile,
    audioProfileName: masteringProfileName,
    audioBitrateKbps: settings.bitRateKbps,
    audioSourceSignature: signature,
    audioRev: Math.floor(statSync(destination).mtimeMs),
    bakedGainDb: 0,
    audioLufs: metrics.lufs,
    audioLra: metrics.lra,
    audioTruePeak: metrics.truePeak,
    audioMaxMomentary: metrics.maxMomentary,
    audioMaxShortTerm: metrics.maxShortTerm,
  });
}

async function masterWorker() {
  while (masterCursor < clips.length) {
    const clip = clips[masterCursor++];
    await masterClip(clip);
    masteredCount += 1;
    if (masteredCount % 5 === 0) saveClips();
    process.stdout.write(`\rMastered ${masteredCount}/${clips.length} soundtracks`);
  }
}

await Promise.all(Array.from({ length: Math.min(4, clips.length) }, () => masterWorker()));
process.stdout.write(` (${reusedCount} already current)\n`);

// Keep only the mastered soundtracks for the clips that remain public.
for (const name of readdirSync(audioDir)) {
  const id = name.endsWith(".m4a") ? name.slice(0, -4) : "";
  if (/^\d+$/.test(id) && !selected.has(id)) rmSync(join(audioDir, name));
}

// The visual MP4 and mastered M4A are played in sync. Once every master exists,
// remove the redundant old soundtrack from the visual file so the GitHub Pages
// artifact remains below its size limit.
let strippedCount = 0;
for (const clip of clips) {
  const media = join(mediaDir, `${clip.id}.mp4`);
  if (!existsSync(join(audioDir, `${clip.id}.m4a`))) throw new Error(`Missing master for clip ${clip.id}`);
  if (hasAudio(media)) {
    const temporary = join(mediaDir, `.${clip.id}.silent.mp4`);
    execFileSync("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-i", media,
      "-map", "0:v:0", "-c:v", "copy", "-an",
      "-movflags", "+faststart", "-y", temporary,
    ], { stdio: "inherit" });
    renameSync(temporary, media);
    strippedCount += 1;
  }
  clip.rev = Math.floor(statSync(media).mtimeMs);
  clip.lufs = clip.audioLufs;
  clip.lra = clip.audioLra;
  clip.truePeak = clip.audioTruePeak;
  clip.maxMomentary = clip.audioMaxMomentary;
  clip.maxShortTerm = clip.audioMaxShortTerm;
  clip.gainDb = 0;
  clip.safetyGainDb = 0;
  clip.safetyProfile = masteringProfile;
}

saveClips();
console.log(`Prepared ${clips.length} mastered tracks and stripped ${strippedCount} redundant video soundtracks.`);
