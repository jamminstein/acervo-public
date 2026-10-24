// The little instrument has its own audio path. The archive's persistent native
// audio element stays untouched, including its background/CarPlay behavior.
let mixer = null;
export function getMixer() {
  if (mixer) {
    if (mixer.context.state === 'suspended') mixer.context.resume().catch(() => {});
    return mixer;
  }
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return null;
  const context = new Audio({ latencyHint: 'interactive' });
  const drumGain = context.createGain();
  drumGain.gain.value = .25;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = .003;
  limiter.release.value = .12;
  drumGain.connect(limiter);
  limiter.connect(context.destination);
  mixer = { context, drumGain };
  context.resume().catch(() => {});
  return mixer;
}
