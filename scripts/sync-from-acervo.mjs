import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractWaveform, isValidWaveform } from "./waveforms.mjs";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mediaDir = join(root, "media");
const posterDir = join(root, "posters");
const clipsFile = join(root, "clips.json");
const database = join(homedir(), "Library", "Application Support", "acervo", "acervo.db");
const targetLufs = -16;
const maxPlaybackGainDb = 6;

const previousClips = existsSync(clipsFile)
  ? JSON.parse(readFileSync(clipsFile, "utf8"))
  : [];
const previousById = new Map(previousClips.map((clip) => [Number(clip.id), clip]));

mkdirSync(mediaDir, { recursive: true });
mkdirSync(posterDir, { recursive: true });

const query = `
  SELECT id, path, duration, mtime, width, height
  FROM items
  WHERE public=1 AND hidden=0 AND missing=0 AND kind='video'
  ORDER BY added_at DESC
`;
const clips = JSON.parse(execFileSync("sqlite3", ["-json", database, query], { encoding: "utf8" }) || "[]");

if (!clips.length) throw new Error("ACERVO has no visible clips marked public");

for (const clip of clips) {
  if (!existsSync(clip.path)) throw new Error(`The source drive is unavailable for public clip ${clip.id}`);
}

const selected = new Set(clips.map((clip) => String(clip.id)));
for (const [directory, extension] of [[mediaDir, ".mp4"], [posterDir, ".jpg"]]) {
  for (const name of readdirSync(directory)) {
    const id = name.endsWith(extension) ? name.slice(0, -extension.length) : "";
    if (/^\d+$/.test(id) && !selected.has(id)) rmSync(join(directory, name));
  }
}

let cursor = 0;
let finished = 0;
const prepared = new Map();

async function transcode(clip) {
  const destination = join(mediaDir, `${clip.id}.mp4`);
  const poster = join(posterDir, `${clip.id}.jpg`);
  const sourceMtime = statSync(clip.path).mtimeMs;
  const rotatePortrait = Number(clip.height) > Number(clip.width);
  let needsVideo = !existsSync(destination) || statSync(destination).mtimeMs < sourceMtime;

  if (!needsVideo) {
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type,width,height,bit_rate",
      "-of", "json", destination,
    ], { encoding: "utf8" }));
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
    needsVideo = Math.max(Number(video?.width), Number(video?.height)) > 240
      || Number(audio?.bit_rate || 0) > 52_000
      || (rotatePortrait && Number(video?.height) > Number(video?.width));
  }

  if (needsVideo) {
    const videoFilter = [
      rotatePortrait ? "transpose=clock" : null,
      "scale=240:240:force_original_aspect_ratio=decrease:force_divisible_by=2",
      "format=yuv420p",
    ].filter(Boolean).join(",");
    await run("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-i", clip.path,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", videoFilter,
      "-af", "loudnorm=I=-16:LRA=11:TP=-1.5",
      "-c:v", "libx264", "-preset", "medium", "-crf", "35",
      "-maxrate", "55k", "-bufsize", "110k",
      "-c:a", "aac", "-b:a", "48k", "-ar", "32000",
      "-movflags", "+faststart",
      "-metadata", `comment=ACERVO web preview — source preserved${rotatePortrait ? " — portrait rotated clockwise" : ""}`,
      "-y", destination,
    ], { maxBuffer: 8 * 1024 * 1024 });
  }

  if (!existsSync(poster) || statSync(poster).mtimeMs < statSync(destination).mtimeMs) {
    const frame = Math.max(0.1, Math.min(Number(clip.duration || 1) * 0.25, Number(clip.duration || 1) - 0.1));
    await run("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-ss", String(frame), "-i", destination,
      "-frames:v", "1",
      "-vf", "scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2",
      "-q:v", "4", "-y", poster,
    ], { maxBuffer: 4 * 1024 * 1024 });
  }

  finished += 1;
  prepared.set(clip.id, {
    id: clip.id,
    rev: Math.floor(statSync(destination).mtimeMs),
  });
  process.stdout.write(`\rPrepared ${finished}/${clips.length} public clips`);
}

async function worker() {
  while (cursor < clips.length) {
    const clip = clips[cursor++];
    await transcode(clip);
  }
}

await Promise.all(Array.from({ length: Math.min(4, clips.length) }, () => worker()));
process.stdout.write("\n");

async function measureWebAudio(clip) {
  const current = prepared.get(clip.id);
  const previous = previousById.get(clip.id);
  const mediaPath = join(mediaDir, `${clip.id}.mp4`);
  const waveform = previous?.rev === current.rev && isValidWaveform(previous.waveform)
    ? previous.waveform
    : await extractWaveform(mediaPath);
  if (previous?.rev === current.rev
    && Object.hasOwn(previous, "lufs")
    && Number.isFinite(Number(previous.gainDb))) {
    return {
      ...current,
      lufs: previous.lufs,
      truePeak: previous.truePeak,
      gainDb: previous.gainDb,
      waveform,
    };
  }

  let stderr = "";
  try {
    ({ stderr } = await run("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "info",
      "-i", mediaPath,
      "-map", "0:a:0", "-vn",
      "-af", `loudnorm=I=${targetLufs}:LRA=11:TP=-1.5:print_format=json`,
      "-f", "null", "-",
    ], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }));
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (/matches no streams|does not contain any stream/i.test(message)) {
      return { ...current, lufs: null, truePeak: null, gainDb: 0, waveform };
    }
    throw error;
  }

  const report = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
  if (!report) throw new Error(`Could not measure public clip ${clip.id}`);
  const measured = JSON.parse(report);
  const lufs = Number(measured.input_i);
  const truePeak = Number(measured.input_tp);
  if (!Number.isFinite(lufs)) return { ...current, lufs: null, truePeak: null, gainDb: 0, waveform };
  const gainDb = Math.max(-maxPlaybackGainDb, Math.min(maxPlaybackGainDb, targetLufs - lufs));
  return {
    ...current,
    lufs: Math.round(lufs * 100) / 100,
    truePeak: Number.isFinite(truePeak) ? Math.round(truePeak * 100) / 100 : null,
    gainDb: Math.round(gainDb * 100) / 100,
    waveform,
  };
}

const measured = new Map();
let measureCursor = 0;
let measuredCount = 0;
async function measureWorker() {
  while (measureCursor < clips.length) {
    const clip = clips[measureCursor++];
    measured.set(clip.id, await measureWebAudio(clip));
    measuredCount += 1;
    process.stdout.write(`\rMeasured ${measuredCount}/${clips.length} public clips`);
  }
}

await Promise.all(Array.from({ length: Math.min(12, clips.length) }, () => measureWorker()));
writeFileSync(clipsFile, `${JSON.stringify(clips.map(({ id }) => measured.get(id)), null, 2)}\n`);
process.stdout.write("\n");
