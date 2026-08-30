const grid = document.querySelector("#clips");
const player = document.createElement("video");
player.preload = "none";
player.playsInline = true;

const tiles = [];
let activeTile = null;
let shuffleQueue = [];
let playlistRunning = false;
let audioContext = null;
let audioChain = null;

function shuffle(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapWith]] = [result[swapWith], result[index]];
  }
  return result;
}

async function connectAudio() {
  if (!audioContext) audioContext = new AudioContext();

  if (!audioChain) {
    const source = audioContext.createMediaElementSource(player);
    const compressor = audioContext.createDynamicsCompressor();
    const limiter = audioContext.createDynamicsCompressor();

    compressor.threshold.value = -12;
    compressor.knee.value = 12;
    compressor.ratio.value = 2;
    compressor.attack.value = 0.015;
    compressor.release.value = 0.25;

    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;

    source.connect(compressor).connect(limiter).connect(audioContext.destination);
    audioChain = { source, compressor, limiter };
  }

  if (audioContext.state === "suspended") await audioContext.resume();
}

function stopPlayback() {
  player.pause();
  player.currentTime = 0;
  player.remove();
  activeTile = null;
}

async function playTile(tile) {
  if (activeTile !== tile) {
    player.pause();
    player.src = tile.dataset.src;
    player.poster = tile.dataset.poster;
    tile.append(player);
    activeTile = tile;
  }

  try {
    await connectAudio();
    await player.play();
    tile.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch {
    const failedTile = activeTile;
    stopPlayback();
    if (playlistRunning) void playNext(failedTile);
  }
}

async function playNext(previousTile = null) {
  if (!playlistRunning || !tiles.length) return;

  if (!shuffleQueue.length) {
    shuffleQueue = shuffle(tiles.filter((tile) => tile !== previousTile));
  }

  const nextTile = shuffleQueue.shift();
  if (nextTile) await playTile(nextTile);
}

async function toggle(tile) {
  if (activeTile === tile && !player.paused) {
    playlistRunning = false;
    shuffleQueue = [];
    stopPlayback();
    return;
  }

  playlistRunning = true;
  shuffleQueue = shuffle(tiles.filter((candidate) => candidate !== tile));
  await playTile(tile);
}

const response = await fetch("./clips.json");
const clips = await response.json();

for (const [index, clip] of clips.entries()) {
  const tile = document.createElement("button");
  const poster = `./posters/${clip.id}.jpg?v=${clip.rev}`;
  tile.className = "video-tile";
  tile.type = "button";
  tile.ariaLabel = `Play or stop clip ${index + 1}`;
  tile.dataset.poster = poster;
  tile.dataset.src = `./media/${clip.id}.mp4?v=${clip.rev}`;

  const image = document.createElement("img");
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.src = poster;

  tile.addEventListener("click", () => void toggle(tile));
  tile.append(image);
  tiles.push(tile);
  grid.append(tile);
}

player.addEventListener("ended", () => {
  const finishedTile = activeTile;
  stopPlayback();
  if (playlistRunning) void playNext(finishedTile);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && activeTile) {
    playlistRunning = false;
    shuffleQueue = [];
    stopPlayback();
  }
});
