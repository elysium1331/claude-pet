// Which part of the pet box takes the mouse. Pure, so it can be unit tested.
//
// Windows gives a transparent window every click and touch inside its rectangle, painted or not, and the pet box is
// mostly empty margin in some poses (the lounging fox fills about a third of it). So the window that draws the pet
// never takes input, and a separate invisible hit-area window over the body (from the current pose's insets) does.
// Switching the pet window between click-through and not by cursor position can't work for touch: a finger doesn't
// move the cursor before it lands, so Windows would hand the first touch to the app underneath.
const { bodyRect } = require('./placement');

// Bounds of the hit-area window, in whole DIPs, for a pet box at petPos.
function hitAreaBounds(petPos, petSize, insets) {
  const body = bodyRect(petPos, petSize, insets);
  const x = Math.round(body.left);
  const y = Math.round(body.top);
  return { x, y, width: Math.max(1, Math.round(body.right) - x), height: Math.max(1, Math.round(body.bottom) - y) };
}

// Whether the pet looks hovered. holding: a press or drag on the pet is under way, so it keeps looking hovered when
// the cursor slips off the body, e.g. past a screen edge the pet can't follow.
function pointerPlan({ cursor, petPos, petSize, insets, holding = false }) {
  const area = hitAreaBounds(petPos, petSize, insets);
  const overBody = !!cursor && cursor.x >= area.x && cursor.x < area.x + area.width
    && cursor.y >= area.y && cursor.y < area.y + area.height;
  return { overBody, hovered: overBody || holding };
}

module.exports = { pointerPlan, hitAreaBounds };
