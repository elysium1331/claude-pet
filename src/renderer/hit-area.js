// The invisible window kept over the pet's body. It takes the pet's clicks, drags, touches and right-clicks; the window
// that draws the pet never takes input, so the see-through margins around the body pass clicks to what's underneath.
const area = document.getElementById('hit-area');

let pressed = false;
let moved = false;
let downAt = null;
let lastHoverSent = 0;

area.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || pressed) return; // a second finger or pen doesn't start another press
  pressed = true;
  moved = false;
  downAt = { x: e.screenX, y: e.screenY };
  try {
    area.setPointerCapture(e.pointerId); // moves and the release keep coming here when the cursor slips off the body
  } catch {
    // the pointer is already gone; the press ends on the next move
  }
  window.petHost.press(); // the pet looks hovered until the press ends, even off the body
});

// Every way a press ends. Only a release is a click, and a started drag always reports its end, or the main process
// would keep carrying the pet around.
function endPress(cancelled) {
  if (!pressed) return;
  pressed = false;
  area.classList.remove('dragging');
  if (moved) window.petHost.dragEnd();
  else if (cancelled) window.petHost.release();
  else window.petHost.click(); // main process counts clicks: 1 = stats, 2 = trick, 3+ = tickle
}

area.addEventListener('pointermove', (e) => {
  if (pressed && (e.buttons & 1) === 0) endPress(true); // released somewhere this window never heard about
  if (!pressed) {
    // rubbing the cursor back and forth pets the pet; main process recognizes the gesture
    if (e.timeStamp - lastHoverSent > 30) {
      lastHoverSent = e.timeStamp;
      window.petHost.hoverMove(e.screenX);
    }
    return;
  }
  if (!moved && Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y) > 4) {
    moved = true;
    area.classList.add('dragging');
    window.petHost.dragStart();
  }
  if (moved) window.petHost.dragMove();
});

area.addEventListener('pointerup', () => endPress(false));
area.addEventListener('pointercancel', () => endPress(true)); // e.g. the system took over a touch
area.addEventListener('lostpointercapture', () => endPress(true)); // after a pointerup there's nothing left to end

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.petHost.closeStats();
});

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.petHost.contextMenu();
});
