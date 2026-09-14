// Pure gesture recognizers for playing with the pet. No Electron imports so they can be unit tested.

// What a burst of quick clicks on the pet means.
function classifyClicks(count) {
  if (count <= 0) return null;
  if (count === 1) return 'stats';
  if (count === 2) return 'trick';
  return 'tickle';
}

// Detects quick back-and-forth movement along one axis: rubbing (hover) or shaking (while dragging).
class StrokeDetector {
  constructor({ minTravel, reversals, windowMs, cooldownMs = 0 }) {
    this.minTravel = minTravel;
    this.reversals = reversals;
    this.windowMs = windowMs;
    this.cooldownMs = cooldownMs;
    this.reset();
  }

  reset() {
    this.anchor = null; // furthest point reached in the current direction
    this.direction = 0;
    this.reversalTimes = [];
    this.cooldownUntil = 0;
  }

  // Feed a position; returns true once when the gesture is recognized.
  add(position, time) {
    if (this.anchor === null) {
      this.anchor = position;
      return false;
    }
    const delta = position - this.anchor;
    if (this.direction === 0) {
      if (Math.abs(delta) >= this.minTravel) {
        this.direction = Math.sign(delta);
        this.anchor = position;
      }
      return false;
    }
    if (delta * this.direction > 0) {
      this.anchor = position; // still moving the same way
    } else if (-delta * this.direction >= this.minTravel) {
      this.direction = -this.direction;
      this.anchor = position;
      this.reversalTimes.push(time);
    }

    this.reversalTimes = this.reversalTimes.filter((t) => time - t <= this.windowMs);
    if (this.reversalTimes.length >= this.reversals && time >= this.cooldownUntil) {
      this.reversalTimes = [];
      this.cooldownUntil = time + this.cooldownMs;
      return true;
    }
    return false;
  }
}

// Which screen edge stopped a dragged pet, if it was pushed well past it. The bottom edge is a landing, not a bonk.
function edgeBump(desired, placed, threshold = 12) {
  const dx = desired.x - placed.x;
  if (dx < -threshold) return 'left';
  if (dx > threshold) return 'right';
  if (desired.y - placed.y < -threshold) return 'top';
  return null;
}

module.exports = { classifyClicks, StrokeDetector, edgeBump };
