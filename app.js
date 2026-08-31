const grid = document.querySelector("#clips");
const mediaHost = document.querySelector("#media-host");
const transport = document.querySelector("#transport");
const transportToggle = document.querySelector("#transport-toggle");
const transportNext = document.querySelector("#transport-next");
const timeline = document.querySelector("#timeline");

// The soundtrack has a permanent HTML audio element so iOS and car systems keep
// recognizing it after Safari leaves the foreground. Tile videos are silent visuals.
const audioPlayer = document.createElement("audio");
audioPlayer.preload = "metadata";
audioPlayer.controls = false;
audioPlayer.setAttribute("x-webkit-airplay", "allow");
mediaHost.append(audioPlayer);

const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const previewLimit = window.matchMedia("(max-width: 560px)").matches ? 6 : 12;

const tiles = [];
const visibleTiles = new Set();
let activeTile = null;
let shuffleQueue = [];
let playHistory = [];
let playlistRunning = false;
let audioContext = null;
let audioChain = null;
let previewFrame = 0;

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

async function connectAudio() {
  // iOS receives the already-normalized derivative directly. This avoids Web
  // Audio suspension when the lock screen or CarPlay takes over playback.
  if (isIOS) return;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  if (!audioContext) audioContext = new AudioContextClass();

  if (!audioChain) {
    const source = audioContext.createMediaElementSource(audioPlayer);
    const normalization = audioContext.createGain();
    const compressor = audioContext.createDynamicsCompressor();
    const limiter = audioContext.createDynamicsCompressor();

    compressor.threshold.value = -12;
    compressor.knee.value = 12;
    compressor.ratio.value = 2;
    compressor.attack.value = 0.015;
    compressor.release.value = 0.25;

    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    source.connect(normalization).connect(compressor).connect(limiter).connect(audioContext.destination);
    audioChain = { source, normalization, compressor, limiter };
  }

  if (audioContext.state === "suspended") await audioContext.resume();
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
  if (!preview || reducedMotion || document.hidden) return;

  if (!preview.hasAttribute("src")) {
    preview.src = tile.dataset.src;
    preview.load();
  }

  void preview.play().catch(() => {});
}

function refreshPreviews() {
  previewFrame = 0;
  if (document.hidden) return;

  const selected = new Set(
    [...visibleTiles]
      .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
      .slice(0, previewLimit),
  );

  for (const tile of tiles) {
    if (selected.has(tile)) startPreview(tile);
    else if (tile !== activeTile) stopPreview(tile, !visibleTiles.has(tile));
  }
}

function schedulePreviewRefresh() {
  if (!previewFrame) previewFrame = requestAnimationFrame(refreshPreviews);
}

function setActiveTile(tile) {
  if (activeTile && activeTile !== tile) activeTile.classList.remove("is-active");
  activeTile = tile;
  if (tile) tile.classList.add("is-active");
  schedulePreviewRefresh();
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

function updateTransport() {
  const duration = audioPlayer.duration;
  const progress = Number.isFinite(duration) && duration > 0 ? (audioPlayer.currentTime / duration) * 100 : 0;
  timeline.value = String(progress);
  timeline.style.setProperty("--progress", `${progress}%`);
  transportToggle.classList.toggle("is-paused", audioPlayer.paused);
  transportToggle.ariaLabel = audioPlayer.paused ? "Play" : "Pause";
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
    await connectAudio();
    await audioPlayer.play();
  } catch {}
}

function configureTileGain(tile) {
  const gainDb = Number(tile.dataset.gainDb || 0);
  if (isIOS || !audioChain) {
    // The web exports are already loudness-normalized; negative residual
    // correction can safely attenuate the direct system-audio path.
    audioPlayer.volume = Math.min(1, gainFromDecibels(gainDb));
    return;
  }

  audioPlayer.volume = 1;
  audioChain.normalization.gain.setValueAtTime(gainFromDecibels(gainDb), audioContext.currentTime);
}

async function playTile(tile, { rememberCurrent = true } = {}) {
  if (activeTile === tile && !audioPlayer.paused) return;

  if (activeTile !== tile) {
    if (activeTile && rememberCurrent) playHistory.push(activeTile);
    setActiveTile(tile);
    audioPlayer.pause();
    audioPlayer.src = tile.dataset.src;
    audioPlayer.load();

    const preview = tilePreview(tile);
    startPreview(tile);
    if (preview?.readyState >= 1) preview.currentTime = 0;
  }

  transport.hidden = false;
  document.body.classList.add("has-transport");
  updateMediaMetadata(tile);

  try {
    await connectAudio();
    configureTileGain(tile);
    await audioPlayer.play();
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

const response = await fetch("./clips.json");
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
  tile.dataset.gainDb = String(clip.gainDb || 0);

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

const previewObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visibleTiles.add(entry.target);
      else visibleTiles.delete(entry.target);
    }
    schedulePreviewRefresh();
  },
  { rootMargin: "80px 0px", threshold: 0.08 },
);

for (const tile of tiles) previewObserver.observe(tile);

audioPlayer.addEventListener("play", () => {
  transport.hidden = false;
  document.body.classList.add("has-transport");
  setMediaPlaybackState("playing");
  startPreview(activeTile);
  updateTransport();
});

audioPlayer.addEventListener("pause", () => {
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
  // Only the decorative video previews stop in the background. The persistent
  // audio element intentionally continues for lock-screen and car playback.
  if (document.hidden) {
    for (const tile of tiles) stopPreview(tile);
  } else {
    schedulePreviewRefresh();
    startPreview(activeTile);
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
