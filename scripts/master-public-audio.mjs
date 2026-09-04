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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { analyzeMeanVolume, analyzeToneAndChannels } from "./audio-profile.mjs";
import { analyzeAudioSafety } from "./audio-safety.mjs";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clipsFile = join(root, "clips.json");
const mediaDir = join(root, "media");
const explicitAudioDir = process.env.ACERVO_AUDIO_DIR
  ? resolve(process.env.ACERVO_AUDIO_DIR)
  : null;
const audioDirs = explicitAudioDir
  ? [explicitAudioDir]
  : [
      resolve(root, "..", "acervo-public-audio"),
      resolve(root, "..", "acervo-public-audio-2"),
    ];
const database = join(homedir(), "Library", "Application Support", "acervo", "acervo.db");

// The entire chain is rendered into a normal AAC soundtrack. Fixed programme
// gain avoids the local noise-floor lift caused by dynamic normalization, and
// the native media path remains dependable when Safari is backgrounded or used
// through CarPlay.
export const masteringProfile = 8;
export const masteringProfileName = "car-consistent-v2-noise-aware-originals";
const targetLufs = -16.2;
const hardQuietFloor = -17;
const hardLoudCeiling = -15;
const truePeakCeiling = -1;
const momentaryCeiling = -9.5;
const shortTermCeiling = -11;
const lraCeiling = 10;
const sourceProfileVersion = 1;

const allClips = JSON.parse(readFileSync(clipsFile, "utf8"));
const requestedIds = new Set((process.env.ACERVO_CLIP_IDS || "").split(",").filter(Boolean));
const forceMaster = process.env.ACERVO_FORCE_MASTER === "1";
const clips = requestedIds.size
  ? allClips.filter((clip) => requestedIds.has(String(clip.id)))
  : allClips;
const selected = new Set(allClips.map((clip) => String(clip.id)));
for (const directory of audioDirs) mkdirSync(directory, { recursive: true });

function assignAudioShard(clip) {
  if (explicitAudioDir) return 1;
  if (clip.audioShard === 1 || clip.audioShard === 2) return clip.audioShard;
  if (existsSync(join(audioDirs[0], `${clip.id}.m4a`))) return 1;
  if (existsSync(join(audioDirs[1], `${clip.id}.m4a`))) return 2;
  return 2;
}

function audioPath(clip) {
  return join(audioDirs[clip.audioShard - 1], `${clip.id}.m4a`);
}

for (const clip of clips) clip.audioShard = assignAudioShard(clip);

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
  const path = sourceById.get(String(clip.id));
  return path && hasAudio(path) ? { path, kind: "archive" } : null;
}

function sourceSignature(source) {
  const stats = statSync(source.path);
  return `${source.kind}:${stats.size}:${Math.floor(stats.mtimeMs)}`;
}

function dbToLinear(decibels) {
  return (10 ** (decibels / 20)).toFixed(8);
}

function round(value, precision = 10) {
  return Math.round(value * precision) / precision;
}

function saveClips() {
  const temporary = join(root, ".clips.json.mastering");
  writeFileSync(temporary, `${JSON.stringify(allClips, null, 2)}\n`);
  renameSync(temporary, clipsFile);
}

const sourceFor = new Map();
const missingOriginals = [];
for (const clip of clips) {
  const source = sourceForClip(clip);
  if (!source) missingOriginals.push(clip.id);
  else sourceFor.set(String(clip.id), source);
}
if (missingOriginals.length) {
  throw new Error(`The original archive is unavailable for ${missingOriginals.length} public clips: ${missingOriginals.slice(0, 12).join(", ")}`);
}

function sourceProfileIsCurrent(clip, signature) {
  return clip.sourceProfileVersion === sourceProfileVersion
    && clip.sourceProfileSignature === signature
    && Number.isFinite(clip.sourceChannels)
    && Number.isFinite(clip.sourceFullRms)
    && Number.isFinite(clip.sourceBassDelta)
    && Number.isFinite(clip.sourcePresenceDelta)
    && Number.isFinite(clip.sourceLeftRms)
    && Number.isFinite(clip.sourceRightRms)
    && Number.isFinite(clip.sourceChannelImbalance)
    && Number.isFinite(clip.sourceMonoDelta)
    && Number.isFinite(clip.sourceIntroRms);
}

let profileCursor = 0;
let profiledCount = 0;
let reusedProfileCount = 0;

async function profileClip(clip) {
  const source = sourceFor.get(String(clip.id));
  const signature = sourceSignature(source);
  if (sourceProfileIsCurrent(clip, signature)) {
    reusedProfileCount += 1;
    return;
  }

  const [profile, introRms] = await Promise.all([
    analyzeToneAndChannels(source.path),
    analyzeMeanVolume(source.path, 2),
  ]);
  Object.assign(clip, {
    sourceProfileVersion,
    sourceProfileSignature: signature,
    sourceChannels: profile.channels,
    sourceFullRms: profile.fullRms,
    sourceBassDelta: profile.bassDelta,
    sourcePresenceDelta: profile.presenceDelta,
    sourceLeftRms: profile.leftRms,
    sourceRightRms: profile.rightRms,
    sourceChannelImbalance: profile.channelImbalance,
    sourceMonoDelta: profile.monoDelta,
    sourceIntroRms: introRms,
  });
}

async function profileWorker() {
  while (profileCursor < clips.length) {
    const clip = clips[profileCursor++];
    await profileClip(clip);
    profiledCount += 1;
    if (profiledCount % 10 === 0) saveClips();
    process.stdout.write(`\rProfiled ${profiledCount}/${clips.length} originals`);
  }
}

await Promise.all(Array.from({ length: Math.min(4, clips.length) }, () => profileWorker()));
saveClips();
process.stdout.write(` (${reusedProfileCount} already current)\n`);

function channelMode(clip) {
  if (clip.sourceChannels === 1) return "mono-to-dual-mono";
  if (clip.sourceChannelImbalance <= 20) return "stereo";
  return clip.sourceLeftRms >= clip.sourceRightRms ? "left-to-dual-mono" : "right-to-dual-mono";
}

function conditioningFilters(clip) {
  const filters = [];
  const mode = channelMode(clip);
  if (mode === "mono-to-dual-mono") filters.push("pan=stereo|c0=c0|c1=c0");
  if (mode === "left-to-dual-mono") filters.push("pan=stereo|c0=c0|c1=c0");
  if (mode === "right-to-dual-mono") filters.push("pan=stereo|c0=c1|c1=c1");
  filters.push("highpass=f=30:p=2");
  if (clip.sourceBassDelta > -1) filters.push("bass=f=120:t=q:w=0.7:g=-2.5:p=2");
  if (clip.sourcePresenceDelta > -10) filters.push("equalizer=f=4000:t=q:w=1:g=-2");
  return filters;
}

function dynamicsFilter(clip, settings) {
  return [
    ...conditioningFilters(clip),
    `agate=threshold=${dbToLinear(settings.gateThresholdDb)}:ratio=2:range=0.25118864:attack=12:release=350:knee=4:detection=rms:link=average`,
    `acompressor=threshold=${dbToLinear(settings.compressorThresholdDb)}:ratio=${settings.compressorRatio}:attack=25:release=300:knee=4:makeup=1:link=average:detection=rms`,
  ].join(",");
}

function masteringFilter(clip, settings) {
  return [
    dynamicsFilter(clip, settings),
    `volume=${settings.gainDb.toFixed(3)}dB`,
    "aresample=48000",
    `alimiter=limit=${dbToLinear(settings.finalLimiterDb)}:attack=5:release=100:level=false:latency=true`,
    `volume=${settings.outputPadDb.toFixed(3)}dB`,
  ].join(",");
}

async function stageMetrics(clip, source, settings) {
  return analyzeAudioSafety(source.path, dynamicsFilter(clip, settings));
}

async function renderMaster(clip, source, destination, settings) {
  const temporary = join(dirname(destination), `.${clip.id}.mastering.m4a`);
  await run("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", source.path,
    "-map", "0:a:0", "-vn",
    "-af", masteringFilter(clip, settings),
    "-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-ac", "2",
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
    && Number.isFinite(clip.audioMaxShortTerm)
    && Number.isFinite(clip.audioIntroRms)
    && Number.isFinite(clip.audioChannelImbalance);
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
let reusedMasterCount = 0;

async function masterClip(clip) {
  const source = sourceFor.get(String(clip.id));
  const signature = sourceSignature(source);
  const destination = audioPath(clip);
  const canReuse = !forceMaster
    && existsSync(destination)
    && clip.audioProfile === masteringProfile
    && clip.audioSourceSignature === signature
    && metricsAreCurrent(clip)
    && withinTarget({
      lufs: clip.audioLufs,
      lra: clip.audioLra,
      truePeak: clip.audioTruePeak,
      maxMomentary: clip.audioMaxMomentary,
      maxShortTerm: clip.audioMaxShortTerm,
    });
  if (canReuse) {
    reusedMasterCount += 1;
    return;
  }

  const settings = {
    gateThresholdDb: Math.min(-38, clip.sourceFullRms - 12),
    compressorThresholdDb: Math.min(-18, Math.max(-45, clip.sourceFullRms + 12)),
    compressorRatio: 3,
    finalLimiterDb: -1,
    outputPadDb: -1.5,
    gainDb: 0,
  };
  let stage = await stageMetrics(clip, source, settings);
  settings.gainDb = Math.max(-24, Math.min(48, targetLufs - stage.lufs - settings.outputPadDb));
  let metrics;

  for (let pass = 0; pass < 24; pass += 1) {
    await renderMaster(clip, source, destination, settings);
    metrics = await analyzeAudioSafety(destination);
    if (process.env.ACERVO_DEBUG) {
      console.log(`\n${clip.id} pass ${pass + 1}`, settings, metrics);
    }
    if (withinTarget(metrics)) break;

    if (metrics.truePeak > truePeakCeiling) {
      // AAC can add inter-sample overshoot after a perfectly safe PCM render.
      // Move gain from after the limiter to before it: programme loudness stays
      // stable while the limiter absorbs the newly measured codec overshoot.
      const reduction = metrics.truePeak - truePeakCeiling + 0.3;
      settings.outputPadDb = Math.max(-12, settings.outputPadDb - reduction);
      settings.gainDb = Math.min(48, settings.gainDb + reduction);
      continue;
    }

    const needsMoreDynamics = metrics.maxMomentary > momentaryCeiling
      || metrics.maxShortTerm > shortTermCeiling
      || (metrics.lra > lraCeiling && metrics.maxMomentary > -11.5);
    if (needsMoreDynamics && settings.compressorRatio < 12) {
      settings.compressorThresholdDb = Math.max(-64, settings.compressorThresholdDb - 2);
      settings.compressorRatio += 1;
      stage = await stageMetrics(clip, source, settings);
      settings.gainDb = Math.max(-24, Math.min(48, targetLufs - stage.lufs - settings.outputPadDb));
      continue;
    }

    const momentaryReduction = Math.min(
      0,
      momentaryCeiling - metrics.maxMomentary,
      shortTermCeiling - metrics.maxShortTerm,
    );
    if (momentaryReduction < -0.1) settings.gainDb += momentaryReduction;
    else if (metrics.lufs < hardQuietFloor || metrics.lufs > hardLoudCeiling) {
      settings.gainDb += targetLufs - metrics.lufs;
    }
  }

  if (!withinTarget(metrics)) {
    throw new Error(`Master ${clip.id} missed the safety corridor: ${JSON.stringify(metrics)}`);
  }

  const [outputProfile, introRms] = await Promise.all([
    analyzeToneAndChannels(destination),
    analyzeMeanVolume(destination, 2),
  ]);
  const mode = channelMode(clip);
  if (mode !== "stereo" && outputProfile.channelImbalance > 1) {
    throw new Error(`Dual-mono repair failed for clip ${clip.id}`);
  }
  if (Number.isFinite(clip.sourceIntroRms)
    && Number.isFinite(introRms)
    && introRms > clip.sourceIntroRms + settings.gainDb + 1.5) {
    throw new Error(`Opening noise was raised unexpectedly for clip ${clip.id}`);
  }

  Object.assign(clip, {
    audioProfile: masteringProfile,
    audioProfileName: masteringProfileName,
    audioBitrateKbps: 96,
    audioSourceSignature: signature,
    audioRev: Math.floor(statSync(destination).mtimeMs),
    audioChannelMode: mode,
    audioGateThresholdDb: round(settings.gateThresholdDb),
    audioCompressorThresholdDb: round(settings.compressorThresholdDb),
    audioBassCorrectionDb: clip.sourceBassDelta > -1 ? -2.5 : 0,
    audioPresenceCorrectionDb: clip.sourcePresenceDelta > -10 ? -2 : 0,
    audioMasterGainDb: round(settings.gainDb),
    audioOutputPadDb: round(settings.outputPadDb),
    audioIntroRms: introRms,
    audioChannelImbalance: outputProfile.channelImbalance,
    audioMonoDelta: outputProfile.monoDelta,
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
    process.stdout.write(`\rMastered ${masteredCount}/${clips.length} original soundtracks`);
  }
}

await Promise.all(Array.from({ length: Math.min(4, clips.length) }, () => masterWorker()));
process.stdout.write(` (${reusedMasterCount} already current)\n`);

for (const directory of audioDirs) {
  for (const name of readdirSync(directory)) {
    const id = name.endsWith(".m4a") ? name.slice(0, -4) : "";
    if (!requestedIds.size && /^\d+$/.test(id) && !selected.has(id)) rmSync(join(directory, name));
  }
}

for (const clip of clips) {
  const media = join(mediaDir, `${clip.id}.mp4`);
  if (!existsSync(audioPath(clip))) throw new Error(`Missing master for clip ${clip.id}`);
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
console.log(`Prepared ${clips.length} noise-aware original-source masters across ${audioDirs.length} audio shard${audioDirs.length === 1 ? "" : "s"}.`);
