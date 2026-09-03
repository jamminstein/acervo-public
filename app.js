const grid = document.querySelector("#clips");
const mediaHost = document.querySelector("#media-host");
const transport = document.querySelector("#transport");
const transportToggle = document.querySelector("#transport-toggle");
const transportNext = document.querySelector("#transport-next");
const timelineShell = document.querySelector("#timeline-shell");
const timeline = document.querySelector("#timeline");
const waveformCanvas = document.querySelector("#waveform");
const waveformContext = waveformCanvas.getContext("2d");
const audioBase = "https://jamminstein.github.io/acervo-public-audio";

// The soundtrack has a permanent HTML audio element so iOS and car systems keep
// recognizing it after Safari leaves the foreground. Only the selected tile
// loads a silent visual, keeping the rest of the grid lightweight.
const audioPlayer = document.createElement("audio");
audioPlayer.preload = "metadata";
audioPlayer.controls = false;
audioPlayer.setAttribute("x-webkit-airplay", "allow");
mediaHost.append(audioPlayer);

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const tiles = [];
let activeTile = null;
let shuffleQueue = [];
let playHistory = [];
let playlistRunning = false;
let prefetchedAudioUrl = "";
const waveformCache = new WeakMap();

function gainFromDecibels(decibels) {
  return 10 ** (decibels / 20);
}

function shuffle(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapWith]] = [result[swapWith], result[index]];
  }
  return result;
}

function prefetchNextAudio() {
  if (navigator.connection?.saveData) return;
  const nextUrl = shuffleQueue[0]?.dataset.audioSrc;
  if (!nextUrl || nextUrl === prefetchedAudioUrl) return;
  prefetchedAudioUrl = nextUrl;
  void fetch(nextUrl, { mode: "cors", cache: "force-cache" }).catch(() => {
    if (prefetchedAudioUrl === nextUrl) prefetchedAudioUrl = "";
  });
}

function tilePreview(tile) {
  return tile?.querySelector(".video-preview");
}

function stopPreview(tile, unload = false) {
  const preview = tilePreview(tile);
  if (!preview) return;
  preview.pause();
  tile.classList.remove("preview-ready");
  if (unload && preview.hasAttribute("src")) {
    preview.removeAttribute("src");
    preview.load();
  }
}

function startPreview(tile) {
  const preview = tilePreview(tile);
  if (!preview || document.hidden) return;

  if (!preview.hasAttribute("src")) {
    preview.src = tile.dataset.src;
    preview.load();
  }

  void preview.play().catch(() => {});
}

function setActiveTile(tile) {
  if (activeTile && activeTile !== tile) {
    activeTile.classList.remove("is-active");
    stopPreview(activeTile, true);
  }
  activeTile = tile;
  if (tile) tile.classList.add("is-active");
}

function setMediaPlaybackState(state) {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state;
}

function updateMediaPosition() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const duration = audioPlayer.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;

  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: audioPlayer.playbackRate,
      position: Math.min(Math.max(audioPlayer.currentTime, 0), duration),
    });
  } catch {}
}

function updateMediaMetadata(tile) {
  if (!("mediaSession" in navigator) || !("MediaMetadata" in window) || !tile) return;
  const number = tiles.indexOf(tile) + 1;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: "ACERVO",
    artist: `Clip ${number} of ${tiles.length}`,
    album: "Public collection",
    artwork: [
      {
        src: new URL(tile.dataset.poster, window.location.href).href,
        sizes: "640x360",
        type: "image/jpeg",
      },
    ],
  });
}

function syncActivePreview() {
  const preview = tilePreview(activeTile);
  if (!preview || !Number.isFinite(audioPlayer.currentTime)) return;
  if (Math.abs(preview.currentTime - audioPlayer.currentTime) > 0.3) {
    preview.currentTime = audioPlayer.currentTime;
  }
}

function waveformForTile(tile) {
  if (!tile?.dataset.waveform) return null;
  if (waveformCache.has(tile)) return waveformCache.get(tile);

  try {
    const encoded = atob(tile.dataset.waveform);
    const values = Uint8Array.from(encoded, (character) => character.charCodeAt(0));
    waveformCache.set(tile, values);
    return values;
  } catch {
    waveformCache.set(tile, null);
    return null;
  }
}

function drawWaveform(progress = Number(timeline.value) / 100) {
  const bounds = timelineShell.getBoundingClientRect();
  const width = Math.round(bounds.width);
  const height = Math.round(bounds.height);
  if (!width || !height) return;

  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const canvasWidth = Math.round(width * scale);
  const canvasHeight = Math.round(height * scale);
  if (waveformCanvas.width !== canvasWidth || waveformCanvas.height !== canvasHeight) {
    waveformCanvas.width = canvasWidth;
    waveformCanvas.height = canvasHeight;
  }

  waveformContext.setTransform(scale, 0, 0, scale, 0, 0);
  waveformContext.clearRect(0, 0, width, height);
  const values = waveformForTile(activeTile);
  if (!values?.length) return;

  const center = height / 2;
  const playedUntil = width * Math.max(0, Math.min(1, progress));
  const amplitudes = Array.from(values, (_, index) => {
    const start = Math.max(0, index - 2);
    const end = Math.min(values.length, index + 3);
    let sum = 0;
    for (let neighbor = start; neighbor < end; neighbor += 1) sum += values[neighbor];
    return 1.5 + (sum / (end - start) / 255) * (center - 3);
  });
  const shape = new Path2D();

  shape.moveTo(0, center);
  for (const [index, amplitude] of amplitudes.entries()) {
    const x = (index / (amplitudes.length - 1)) * width;
    shape.lineTo(x, center - amplitude);
  }
  for (let index = amplitudes.length - 1; index >= 0; index -= 1) {
    const x = (index / (amplitudes.length - 1)) * width;
    shape.lineTo(x, center + amplitudes[index]);
  }
  shape.closePath();

  waveformContext.fillStyle = "rgba(255,255,255,0.16)";
  waveformContext.fill(shape);
  waveformContext.save();
  waveformContext.beginPath();
  waveformContext.rect(0, 0, playedUntil, height);
  waveformContext.clip();
  waveformContext.fillStyle = "rgba(255,255,255,0.52)";
  waveformContext.fill(shape);
  waveformContext.restore();
}

function updateTransport() {
  const duration = audioPlayer.duration;
  const progress = Number.isFinite(duration) && duration > 0 ? (audioPlayer.currentTime / duration) * 100 : 0;
  timeline.value = String(progress);
  timeline.style.setProperty("--progress", `${progress}%`);
  transportToggle.classList.toggle("is-paused", audioPlayer.paused);
  transportToggle.ariaLabel = audioPlayer.paused ? "Play" : "Pause";
  drawWaveform(progress / 100);
}

function stopPlayback({ hideTransport = true } = {}) {
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  setActiveTile(null);
  if (hideTransport) {
    transport.hidden = true;
    document.body.classList.remove("has-transport");
  }
  setMediaPlaybackState("none");
  updateTransport();
}

async function resumePlayback() {
  if (!activeTile) return;
  try {
    await audioPlayer.play();
  } catch {}
}

function configureTileGain(tile) {
  const gainDb = Number(tile.dataset.gainDb || 0);
  // Every published clip has an offline master. Keeping this on the native
  // media path makes the same soundtrack reliable in Safari and CarPlay.
  audioPlayer.volume = Math.min(1, gainFromDecibels(gainDb));
}

async function playTile(tile, { rememberCurrent = true } = {}) {
  if (activeTile === tile && !audioPlayer.paused) return;

  if (activeTile !== tile) {
    if (activeTile && rememberCurrent) playHistory.push(activeTile);
    setActiveTile(tile);
    audioPlayer.pause();
    audioPlayer.src = tile.dataset.audioSrc || tile.dataset.src;
    audioPlayer.load();

    const preview = tilePreview(tile);
    startPreview(tile);
    if (preview?.readyState >= 1) preview.currentTime = 0;
  }

  transport.hidden = false;
  document.body.classList.add("has-transport");
  updateMediaMetadata(tile);

  try {
    configureTileGain(tile);
    await audioPlayer.play();
    prefetchNextAudio();
    const compactScreen = window.matchMedia("(max-width: 560px)").matches;
    if (!document.hidden) {
      tile.scrollIntoView({
        behavior: compactScreen || reducedMotion ? "auto" : "smooth",
        block: "center",
      });
    }
  } catch {
    const failedTile = activeTile;
    setActiveTile(null);
    if (playlistRunning) void playNext(failedTile);
  }
}

async function playNext(previousTile = null) {
  if (!playlistRunning || !tiles.length) return;

  if (!shuffleQueue.length) {
    shuffleQueue = shuffle(tiles.filter((tile) => tile !== previousTile));
  }

  const nextTile = shuffleQueue.shift();
  if (nextTile) await playTile(nextTile, { rememberCurrent: true });
}

async function playPrevious() {
  if (audioPlayer.currentTime > 3 || !playHistory.length) {
    audioPlayer.currentTime = 0;
    syncActivePreview();
    return;
  }

  const previousTile = playHistory.pop();
  if (previousTile) await playTile(previousTile, { rememberCurrent: false });
}

async function toggle(tile) {
  if (activeTile === tile && !audioPlayer.paused) {
    playlistRunning = false;
    shuffleQueue = [];
    playHistory = [];
    stopPlayback();
    return;
  }

  if (activeTile === tile) {
    playlistRunning = true;
    await resumePlayback();
    return;
  }

  playlistRunning = true;
  shuffleQueue = shuffle(tiles.filter((candidate) => candidate !== tile));
  await playTile(tile);
}

const response = await fetch("./clips.json?v=20260903-3");
const clips = await response.json();
const randomizedClips = shuffle(clips);

for (const [index, clip] of randomizedClips.entries()) {
  const tile = document.createElement("button");
  const poster = `./posters/${clip.id}.jpg?v=${clip.rev}`;
  tile.className = "video-tile";
  tile.type = "button";
  tile.ariaLabel = `Play or stop clip ${index + 1}`;
  tile.dataset.poster = poster;
  tile.dataset.src = `./media/${clip.id}.mp4?v=${clip.rev}`;
  tile.dataset.audioSrc = clip.audioRev ? `${audioBase}/${clip.id}.m4a?v=${clip.audioRev}` : "";
  tile.dataset.gainDb = String(clip.audioRev ? 0 : (clip.safetyGainDb ?? clip.gainDb ?? 0));
  tile.dataset.waveform = clip.waveform || "";

  const image = document.createElement("img");
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.draggable = false;
  image.src = poster;

  const preview = document.createElement("video");
  preview.className = "video-preview";
  preview.preload = "none";
  preview.muted = true;
  preview.loop = true;
  preview.playsInline = true;
  preview.disablePictureInPicture = true;
  preview.setAttribute("playsinline", "");
  preview.setAttribute("webkit-playsinline", "");
  preview.setAttribute("aria-hidden", "true");
  preview.addEventListener("playing", () => tile.classList.add("preview-ready"));

  const playMark = document.createElement("span");
  playMark.className = "tile-play";
  playMark.setAttribute("aria-hidden", "true");

  tile.addEventListener("click", () => void toggle(tile));
  tile.append(image, preview, playMark);
  tiles.push(tile);
  grid.append(tile);
}

audioPlayer.addEventListener("play", () => {
  transport.hidden = false;
  document.body.classList.add("has-transport");
  setMediaPlaybackState("playing");
  startPreview(activeTile);
  updateTransport();
});

audioPlayer.addEventListener("pause", () => {
  tilePreview(activeTile)?.pause();
  if (!audioPlayer.ended) setMediaPlaybackState(activeTile ? "paused" : "none");
  updateTransport();
});

audioPlayer.addEventListener("loadedmetadata", () => {
  const preview = tilePreview(activeTile);
  if (preview?.readyState >= 1) preview.currentTime = audioPlayer.currentTime;
  updateTransport();
  updateMediaPosition();
});

audioPlayer.addEventListener("timeupdate", () => {
  updateTransport();
  syncActivePreview();
  updateMediaPosition();
});

audioPlayer.addEventListener("ended", () => {
  const finishedTile = activeTile;
  if (finishedTile) playHistory.push(finishedTile);
  setActiveTile(null);
  if (playlistRunning) void playNext(finishedTile);
  else stopPlayback();
});

document.addEventListener("visibilitychange", () => {
  // Only the selected video stops in the background. The persistent
  // audio element intentionally continues for lock-screen and car playback.
  if (document.hidden) {
    tilePreview(activeTile)?.pause();
  } else {
    if (!audioPlayer.paused) startPreview(activeTile);
    syncActivePreview();
  }
});

transportToggle.addEventListener("click", () => {
  if (audioPlayer.paused) void resumePlayback();
  else audioPlayer.pause();
});

transportNext.addEventListener("click", () => {
  playlistRunning = true;
  void playNext(activeTile);
});

timeline.addEventListener("input", () => {
  if (!Number.isFinite(audioPlayer.duration)) return;
  audioPlayer.currentTime = (Number(timeline.value) / 100) * audioPlayer.duration;
  syncActivePreview();
  updateTransport();
});

if ("ResizeObserver" in window) {
  new ResizeObserver(() => drawWaveform()).observe(timelineShell);
} else {
  window.addEventListener("resize", () => drawWaveform());
}

if ("mediaSession" in navigator) {
  const actions = {
    play: () => void resumePlayback(),
    pause: () => audioPlayer.pause(),
    stop: () => {
      playlistRunning = false;
      shuffleQueue = [];
      stopPlayback();
    },
    nexttrack: () => {
      playlistRunning = true;
      void playNext(activeTile);
    },
    previoustrack: () => void playPrevious(),
    seekbackward: (details) => {
      audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - (details.seekOffset || 10));
    },
    seekforward: (details) => {
      const end = Number.isFinite(audioPlayer.duration) ? audioPlayer.duration : audioPlayer.currentTime + 10;
      audioPlayer.currentTime = Math.min(end, audioPlayer.currentTime + (details.seekOffset || 10));
    },
    seekto: (details) => {
      if (typeof details.seekTime === "number") audioPlayer.currentTime = details.seekTime;
    },
  };

  for (const [action, handler] of Object.entries(actions)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {}
  }
}
