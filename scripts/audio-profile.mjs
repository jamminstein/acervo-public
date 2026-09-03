import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

function channelCount(path) {
  try {
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=channels",
      "-of", "json",
      path,
    ], { encoding: "utf8" }));
    return Number(probe.streams?.[0]?.channels || 0);
  } catch {
    return 0;
  }
}

function volumeValues(stderr) {
  const values = new Map();
  for (const match of stderr.matchAll(/Parsed_volumedetect_(\d+).*mean_volume:\s*(-?\d+(?:\.\d+)?) dB/g)) {
    values.set(Number(match[1]), Number(match[2]));
  }
  return values;
}

export async function analyzeMeanVolume(path, seconds = null) {
  const args = ["-nostdin", "-hide_banner", "-nostats"];
  if (Number.isFinite(seconds)) args.push("-t", String(seconds));
  args.push(
    "-i", path,
    "-map", "0:a:0", "-vn",
    "-af", "volumedetect",
    "-f", "null", "-",
  );

  let stderr = "";
  try {
    ({ stderr } = await run("ffmpeg", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
  } catch (error) {
    stderr = String(error?.stderr ?? "");
  }
  const match = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  return match ? Number(match[1]) : null;
}

export async function analyzeToneAndChannels(path) {
  const stereo = channelCount(path) >= 2;
  const graph = stereo
    ? "[0:a]asplit=6[full][low][presence][left][right][mono];"
      + "[full]volumedetect[fullout];"
      + "[low]lowpass=f=140:p=2,volumedetect[lowout];"
      + "[presence]highpass=f=2500:p=2,lowpass=f=6500:p=2,volumedetect[presenceout];"
      + "[left]pan=mono|c0=c0,volumedetect[leftout];"
      + "[right]pan=mono|c0=c1,volumedetect[rightout];"
      + "[mono]pan=mono|c0=0.5*c0+0.5*c1,volumedetect[monoout]"
    : "[0:a]asplit=3[full][low][presence];"
      + "[full]volumedetect[fullout];"
      + "[low]lowpass=f=140:p=2,volumedetect[lowout];"
      + "[presence]highpass=f=2500:p=2,lowpass=f=6500:p=2,volumedetect[presenceout]";
  const maps = stereo
    ? ["[fullout]", "[lowout]", "[presenceout]", "[leftout]", "[rightout]", "[monoout]"]
    : ["[fullout]", "[lowout]", "[presenceout]"];

  let stderr = "";
  try {
    ({ stderr } = await run("ffmpeg", [
      "-nostdin", "-hide_banner", "-nostats",
      "-i", path,
      "-filter_complex", graph,
      ...maps.flatMap((map) => ["-map", map]),
      "-f", "null", "-",
    ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    stderr = String(error?.stderr ?? "");
  }

  const values = volumeValues(stderr);
  const fullRms = values.get(1);
  const lowRms = values.get(3);
  const presenceRms = values.get(6);
  if (![fullRms, lowRms, presenceRms].every(Number.isFinite)) {
    throw new Error(`Could not profile tone for ${path}`);
  }

  const leftRms = stereo ? values.get(8) : fullRms;
  const rightRms = stereo ? values.get(10) : fullRms;
  const monoRms = stereo ? values.get(12) : fullRms;
  return {
    channels: stereo ? 2 : 1,
    fullRms,
    bassDelta: Math.round((lowRms - fullRms) * 10) / 10,
    presenceDelta: Math.round((presenceRms - fullRms) * 10) / 10,
    leftRms,
    rightRms,
    channelImbalance: Math.round(Math.abs(leftRms - rightRms) * 10) / 10,
    monoDelta: Math.round((monoRms - Math.max(leftRms, rightRms)) * 10) / 10,
  };
}
