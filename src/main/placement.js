// Pure screen-placement math (all values in screen DIPs). No Electron imports so it can be unit tested.
//
// The pet window is a box larger than the visible creature. `insets` are fractions of that box that are
// transparent margin on each side, so clamping keeps the creature's *body* on screen, not the box.

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };
// Displays that meet can be a DIP or so apart once Windows scales each one differently.
const SEAM_PX = 2;
// Room kept between the body and a bare screen edge: an auto-hidden taskbar slides out when the cursor touches the
// last pixels there, and the hit area over the body would take that touch instead.
const SCREEN_EDGE_GAP_PX = 4;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function insetPx(insets = ZERO_INSETS, size) {
  return {
    top: (insets?.top || 0) * size.height,
    right: (insets?.right || 0) * size.width,
    bottom: (insets?.bottom || 0) * size.height,
    left: (insets?.left || 0) * size.width,
  };
}

const rightOf = (rect) => rect.x + rect.width;
const bottomOf = (rect) => rect.y + rect.height;

// The display a point is on, or the closest one when it is on none (bounds are half-open, like pixels).
function nearestDisplay(point, displays) {
  let best = displays[0];
  let bestDistance = Infinity;
  for (const display of displays) {
    const b = display.bounds;
    const dx = point.x < b.x ? b.x - point.x : Math.max(0, point.x - rightOf(b) + 1);
    const dy = point.y < b.y ? b.y - point.y : Math.max(0, point.y - bottomOf(b) + 1);
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      best = display;
      bestDistance = distance;
    }
  }
  return best;
}

// Which edge of a display its taskbar is on, from the room it takes out of the work area: 'bottom', 'top', 'left',
// 'right', or null when it takes none (the taskbar hides itself, or this display has none).
function taskbarEdge({ bounds, workArea }) {
  const room = {
    bottom: bottomOf(bounds) - bottomOf(workArea),
    top: workArea.y - bounds.y,
    left: workArea.x - bounds.x,
    right: rightOf(bounds) - rightOf(workArea),
  };
  let edge = null;
  for (const [name, px] of Object.entries(room)) if (px > (room[edge] ?? 0)) edge = name;
  return edge;
}

// Where a pet box can go on one display: its body inside the work area, and SCREEN_EDGE_GAP_PX clear of any edge
// where the work area reaches the screen's edge (when bounds are known).
function boxLimits({ workArea, bounds = null }, petSize, ins) {
  const gap = (atScreenEdge) => (bounds && atScreenEdge ? SCREEN_EDGE_GAP_PX : 0);
  return {
    minX: workArea.x - ins.left + gap(bounds && workArea.x <= bounds.x),
    maxX: rightOf(workArea) - petSize.width + ins.right - gap(bounds && rightOf(workArea) >= rightOf(bounds)),
    minY: workArea.y - ins.top + gap(bounds && workArea.y <= bounds.y),
    maxY: bottomOf(workArea) - petSize.height + ins.bottom - gap(bounds && bottomOf(workArea) >= bottomOf(bounds)),
  };
}

const SEAMS = {
  left: { edge: (area) => area.x, facing: rightOf, along: 'y' },
  right: { edge: rightOf, facing: (area) => area.x, along: 'y' },
  top: { edge: (area) => area.y, facing: bottomOf, along: 'x' },
  bottom: { edge: bottomOf, facing: (area) => area.y, along: 'x' },
};

// The way through one edge of a display into another display whose work area carries on from it: that display, and
// the range (of box y for a side edge, box x for the top or bottom) where the body fits on both, or null for a wall.
//
// It is worked out from both displays' limits alike, so a pet moving across meets the same seam whichever of the two
// it is counted on, with no jump when that changes. Displays of different heights share only part of the edge (e.g.
// the one with the taskbar has the higher ground); a pet that would have to be moved further than its own size to
// fit there, such as at a monitor that starts far below it, finds a wall.
function seamAcross(side, pos, { limits, workArea, neighbours, petSize, ins }) {
  const { edge, facing, along } = SEAMS[side];
  const [low, high] = along === 'y' ? ['minY', 'maxY'] : ['minX', 'maxX'];
  const reach = along === 'y' ? petSize.height : petSize.width;
  let best = null;
  for (const other of neighbours) {
    if (Math.abs(edge(workArea) - facing(other.workArea)) > SEAM_PX) continue;
    const theirs = boxLimits(other, petSize, ins);
    const min = Math.max(limits[low], theirs[low]);
    const max = Math.min(limits[high], theirs[high]);
    if (min > max) continue;
    const fit = clamp(pos[along], min, max);
    const nudge = Math.max(
      Math.abs(fit - clamp(pos[along], limits[low], limits[high])),
      Math.abs(fit - clamp(pos[along], theirs[low], theirs[high])),
    );
    if (nudge <= reach && !(best && best.nudge <= nudge)) best = { display: other, min, max, nudge };
  }
  return best;
}

// Keeps the body inside the work area (which excludes the taskbar) and snaps it onto the bottom edge, its ground,
// when it comes within `snapPx` of it.
//
// bounds: the display's bounds. Where the work area reaches a screen edge (no taskbar showing there), the body keeps
// SCREEN_EDGE_GAP_PX away from it, so the bottom of the screen is the ground when the taskbar is hidden or elsewhere.
// neighbours: the other displays ({ workArea, bounds }). An edge another display carries on from is neither a wall
// nor ground (see seamAcross), so the pet can straddle two monitors and move across without stopping at the seam.
function clampPet(pos, {
  petSize, insets, workArea, bounds = null, neighbours = [], snapPx = 0,
}) {
  const ins = insetPx(insets, petSize);
  const limits = boxLimits({ workArea, bounds }, petSize, ins);
  const seam = (side) => seamAcross(side, pos, { limits, workArea, neighbours, petSize, ins });

  // A body crossing a side seam is on both displays, so it keeps to the heights both have room for (and stands on the
  // higher ground); one crossing the top or bottom keeps to the widths both have.
  const left = pos.x < limits.minX ? seam('left') : null;
  const right = pos.x > limits.maxX ? seam('right') : null;
  const side = left || right;
  let x = clamp(pos.x, left ? -Infinity : limits.minX, right ? Infinity : limits.maxX);
  const minY = side ? side.min : limits.minY;
  const maxY = side ? side.max : limits.maxY;

  const top = side ? null : seam('top');
  const bottom = side ? null : seam('bottom');
  const crossing = (pos.y < minY && top) || (pos.y > maxY && bottom);
  if (crossing) x = clamp(x, crossing.min, crossing.max);
  let y = clamp(pos.y, top ? -Infinity : minY, bottom ? Infinity : maxY);

  const grounded = !bottom && maxY - y <= snapPx;
  if (grounded) y = maxY;
  return { x: Math.round(x), y: Math.round(y), grounded };
}

// clampPet's limits for a pet on `display`, one of `displays` (e.g. Electron's screen.getAllDisplays()).
function displayLimits(display, displays) {
  return { workArea: display.workArea, bounds: display.bounds, neighbours: displays.filter((d) => d !== display) };
}

// Where a pet box at x on `display` comes to rest straight down: on that display's ground, or on the ground of the
// display below when the bottom edge carries on into one.
function groundBelow(x, {
  petSize, insets, display, displays,
}) {
  const ins = insetPx(insets, petSize);
  let current = display;
  let left = x;
  for (let hops = 0; hops < displays.length; hops += 1) {
    const limits = displayLimits(current, displays);
    const placed = clampPet({ x: left, y: Number.MAX_SAFE_INTEGER }, { petSize, insets, ...limits });
    if (placed.grounded) return placed;
    const below = seamAcross('bottom', placed, {
      limits: boxLimits(current, petSize, ins), workArea: current.workArea, neighbours: limits.neighbours, petSize, ins,
    });
    if (!below) break;
    current = below.display;
    left = placed.x;
  }
  return clampPet({ x: left, y: Number.MAX_SAFE_INTEGER }, { petSize, insets, workArea: current.workArea, bounds: current.bounds });
}

// Insets that keep every one of several bodies inside the same limits: the smallest margin on each side.
function combinedInsets(list) {
  const sides = ['top', 'right', 'bottom', 'left'];
  return Object.fromEntries(sides.map((side) => [side, Math.min(...list.map((insets) => insets?.[side] || 0))]));
}

// Where the body is on screen for a pet box at `petPos`: the box without its transparent margins.
function bodyRect(petPos, petSize, insets) {
  const ins = insetPx(insets, petSize);
  return {
    left: petPos.x + ins.left,
    top: petPos.y + ins.top,
    right: petPos.x + petSize.width - ins.right,
    bottom: petPos.y + petSize.height - ins.bottom,
  };
}

// Places a panel centered over the pet's body, above it when there's room, otherwise below. When it fits on
// neither side it goes on the side with more room, kept inside the work area, so it covers as little of the pet as
// it can.
function panelPlacement({ petPos, petSize, insets, panelSize, workArea, gap = 4, margin = 8 }) {
  const { top: bodyTop, bottom: bodyBottom } = bodyRect(petPos, petSize, insets);
  const centerX = petPos.x + petSize.width / 2;
  const x = Math.round(clamp(
    centerX - panelSize.width / 2,
    workArea.x + margin,
    workArea.x + workArea.width - panelSize.width - margin,
  ));
  const topY = workArea.y + margin;
  const bottomY = workArea.y + workArea.height - margin;

  const aboveY = Math.round(bodyTop - gap - panelSize.height);
  if (aboveY >= topY) return { x, y: aboveY, side: 'above' };

  const belowY = Math.round(bodyBottom + gap);
  if (belowY + panelSize.height <= bottomY) return { x, y: belowY, side: 'below' };

  const roomAbove = bodyTop - gap - topY;
  const roomBelow = bottomY - (bodyBottom + gap);
  if (roomAbove >= roomBelow) return { x, y: Math.round(topY), side: 'above' };
  return { x, y: Math.round(Math.max(topY, bottomY - panelSize.height)), side: 'below' };
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
  ZERO_INSETS, SCREEN_EDGE_GAP_PX, clampPet, displayLimits, groundBelow, nearestDisplay, taskbarEdge, combinedInsets,
  bodyRect, panelPlacement, chooseFacing, mirrorInsets, scaledPetSize, resizeAnchored, positionChanged,
};
