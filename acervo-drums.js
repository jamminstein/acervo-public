const machine = document.querySelector('#drumMachine');
const grip = machine.querySelector('.drum-grab');
let drag = null;
let userPosition = null;
function place(x, y) {
  const bounds = machine.getBoundingClientRect();
  const maxX = Math.max(16, document.documentElement.clientWidth - bounds.width - 30);
  const clearance = matchMedia('(max-width: 720px)').matches ? 100 : 28;
  const maxY = Math.max(80, innerHeight - bounds.height - clearance);
  userPosition = { x: Math.max(16, Math.min(maxX, x)), y: Math.max(80, Math.min(maxY, y)) };
  machine.style.left = `${userPosition.x}px`;
  machine.style.top = `${userPosition.y}px`;
  machine.style.bottom = 'auto';
}
grip.addEventListener('pointerdown', event => {
  if (event.button !== 0 || drag) return;
  event.preventDefault();
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: machine.offsetLeft, top: machine.offsetTop };
  grip.setPointerCapture(event.pointerId);
});
grip.addEventListener('pointermove', event => {
  if (!drag || drag.id !== event.pointerId) return;
  place(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) grip.addEventListener(name, event => {
  if (drag?.id === event.pointerId) drag = null;
});
grip.addEventListener('keydown', event => {
  const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
  if (!delta) return;
  event.preventDefault();
  place(machine.offsetLeft + delta[0], machine.offsetTop + delta[1]);
});
window.addEventListener('resize', () => {
  if (userPosition) place(userPosition.x, userPosition.y);
});
