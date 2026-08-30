const grid = document.querySelector("#clips");
let activeVideo = null;

function stop(video) {
  video.pause();
  video.currentTime = 0;
  if (activeVideo === video) activeVideo = null;
}

async function toggle(video) {
  if (activeVideo && activeVideo !== video) stop(activeVideo);

  if (!video.paused) {
    stop(video);
    return;
  }

  try {
    await video.play();
    activeVideo = video;
  } catch {
    activeVideo = null;
  }
}

const response = await fetch("./clips.json");
const clips = await response.json();

for (const [index, clip] of clips.entries()) {
  const tile = document.createElement("button");
  tile.className = "video-tile";
  tile.type = "button";
  tile.ariaLabel = `Play or stop clip ${index + 1}`;

  const video = document.createElement("video");
  video.preload = "none";
  video.playsInline = true;
  video.poster = `./posters/${clip.id}.jpg`;
  video.src = `./media/${clip.id}.mp4`;

  video.addEventListener("ended", () => stop(video));
  tile.addEventListener("click", () => void toggle(video));
  tile.append(video);
  grid.append(tile);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden && activeVideo) stop(activeVideo);
});
