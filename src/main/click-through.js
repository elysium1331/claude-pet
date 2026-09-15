// Which part of the pet window takes the mouse. Pure, so it can be unit tested.
//
// Windows gives a transparent window every click inside its rectangle, painted or not, and the pet box is mostly
// empty margin in some poses (the lounging fox fills about a third of it). So the margins are click-through and only
// the body, from the current pose's insets, takes clicks.
const { bodyRect } = require('./placement');

// holding: a press or drag on the pet is under way. Its moves and its release must still reach the pet when the
// cursor slips off the body, e.g. past a screen edge the pet can't follow.
function pointerPlan({ cursor, petPos, petSize, insets, holding = false }) {
  const body = bodyRect(petPos, petSize, insets);
  const overBody = !!cursor
    && cursor.x >= body.left && cursor.x < body.right && cursor.y >= body.top && cursor.y < body.bottom;
  return { overBody, hovered: overBody || holding, clickThrough: !overBody && !holding };
}

module.exports = { pointerPlan };
