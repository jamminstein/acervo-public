import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, "index.html"), "utf8");
const clips = JSON.parse(readFileSync(join(root, "clips.json"), "utf8"));

assert.ok(clips.length > 0, "the page needs at least one public clip");
assert.match(html, /id="clips"/);
assert.doesNotMatch(html, /<h[1-6]|<p\b|<nav\b|<header\b/i, "the page must contain no visible text interface");

for (const clip of clips) {
  const video = join(root, "media", `${clip.id}.mp4`);
  const poster = join(root, "posters", `${clip.id}.jpg`);
  assert.ok(existsSync(video) && statSync(video).size > 0, `missing video ${clip.id}`);
  assert.ok(existsSync(poster) && statSync(poster).size > 0, `missing poster ${clip.id}`);
  assert.ok(statSync(video).size < 100 * 1024 * 1024, `video ${clip.id} exceeds GitHub's file limit`);
}

console.log(`Verified ${clips.length} public clips.`);
