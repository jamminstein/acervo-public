import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mediaDir = join(root, "media");
const posterDir = join(root, "posters");
const database = join(homedir(), "Library", "Application Support", "acervo", "acervo.db");

mkdirSync(mediaDir, { recursive: true });
mkdirSync(posterDir, { recursive: true });

const query = `
  SELECT id, path, duration, mtime
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

async function transcode(clip) {
  const destination = join(mediaDir, `${clip.id}.mp4`);
  const poster = join(posterDir, `${clip.id}.jpg`);
  const sourceMtime = statSync(clip.path).mtimeMs;

  if (!existsSync(destination) || statSync(destination).mtimeMs < sourceMtime) {
    await run("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-i", clip.path,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", "scale=360:360:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
      "-af", "loudnorm=I=-16:LRA=11:TP=-1.5",
      "-c:v", "libx264", "-preset", "medium", "-crf", "30",
      "-maxrate", "260k", "-bufsize", "520k",
      "-c:a", "aac", "-b:a", "64k", "-ar", "44100",
      "-movflags", "+faststart",
      "-metadata", "comment=ACERVO web preview — source preserved",
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
  process.stdout.write(`\rPrepared ${finished}/${clips.length} public clips`);
}

async function worker() {
  while (cursor < clips.length) {
    const clip = clips[cursor++];
    await transcode(clip);
  }
}

await Promise.all(Array.from({ length: Math.min(4, clips.length) }, () => worker()));
writeFileSync(join(root, "clips.json"), `${JSON.stringify(clips.map(({ id }) => ({ id })), null, 2)}\n`);
process.stdout.write("\n");
