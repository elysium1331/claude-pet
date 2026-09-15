// Pure screen-placement math (all values in screen DIPs). No Electron imports so it can be unit tested.
//
// The pet window is a box larger than the visible creature. `insets` are fractions of that box that are
// transparent margin on each side, so clamping keeps the creature's *body* on screen, not the box.

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function insetPx(insets = ZERO_INSETS, size) {
  return {
    top: (insets.top || 0) * size.height,
    right: (insets.right || 0) * size.width,
    bottom: (insets.bottom || 0) * size.height,
    left: (insets.left || 0) * size.width,
  };
}

// Keeps the body inside the work area (which excludes the taskbar) and snaps it onto the
// bottom edge when it comes within `snapPx` of it.
function clampPet(pos, { petSize, insets, workArea, snapPx = 0 }) {
  const ins = insetPx(insets, petSize);
  const minX = workArea.x - ins.left;
  const maxX = workArea.x + workArea.width - petSize.width + ins.right;
  const minY = workArea.y - ins.top;
  const maxY = workArea.y + workArea.height - petSize.height + ins.bottom;

  const x = clamp(pos.x, minX, maxX);
  let y = clamp(pos.y, minY, maxY);
  const grounded = maxY - y <= snapPx;
  if (grounded) y = maxY;
  return { x: Math.round(x), y: Math.round(y), grounded };
}

// Places a panel centered over the pet's body, above it when there's room, otherwise below.
function panelPlacement({ petPos, petSize, insets, panelSize, workArea, gap = 4, margin = 8 }) {
  const ins = insetPx(insets, petSize);
  const bodyTop = petPos.y + ins.top;
  const bodyBottom = petPos.y + petSize.height - ins.bottom;
  const centerX = petPos.x + petSize.width / 2;
  const x = Math.round(clamp(
    centerX - panelSize.width / 2,
    workArea.x + margin,
    workArea.x + workArea.width - panelSize.width - margin,
  ));

  const aboveY = Math.round(bodyTop - gap - panelSize.height);
  if (aboveY >= workArea.y + margin) return { x, y: aboveY, side: 'above' };

  const belowY = Math.round(bodyBottom + gap);
  if (belowY + panelSize.height <= workArea.y + workArea.height - margin) return { x, y: belowY, side: 'below' };

  return { x, y: workArea.y + margin, side: 'above' };
}

// Faces the pet toward the middle of its screen (1 = right, -1 = left). Inside the dead zone
// around the middle it keeps its current direction so it doesn't flip back and forth.
function chooseFacing({ centerX, workArea, current, deadZone = 0.1 }) {
  const relative = (centerX - workArea.x) / workArea.width;
  if (relative < 0.5 - deadZone / 2) return 1;
  if (relative > 0.5 + deadZone / 2) return -1;
  return current;
}

function mirrorInsets(insets, flipped) {
  if (!flipped) return insets;
  return { ...insets, left: insets.right, right: insets.left };
}

const BASE_PET_SIZE = { width: 150, height: 160 };

function scaledPetSize(scale) {
  const s = Number(scale);
  const safe = Number.isFinite(s) ? Math.min(2, Math.max(0.6, s)) : 1;
  return { width: Math.round(BASE_PET_SIZE.width * safe), height: Math.round(BASE_PET_SIZE.height * safe) };
}

// New top-left for a resized pet box that keeps its bottom center where it was (so it stays on the taskbar).
function resizeAnchored(pos, oldSize, newSize) {
  return {
    x: Math.round(pos.x + (oldSize.width - newSize.width) / 2),
    y: Math.round(pos.y + (oldSize.height - newSize.height)),
  };
}

// Settling in place happens after every pose change, so only a real move needs to be written to config.json.
function positionChanged(saved, pos) {
  return !!pos && !(saved && saved.x === pos.x && saved.y === pos.y);
}

module.exports = {
  ZERO_INSETS, clampPet, panelPlacement, chooseFacing, mirrorInsets, scaledPetSize, resizeAnchored, positionChanged,
};
