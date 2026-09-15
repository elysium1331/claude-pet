// Random ambient motion for ears and tail: quick ear twitches now and then, a slowly drifting tail, the odd flick.
// Loaded as a plain script in the pet window (window.PetAmbient) and required by unit tests in Node.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetAmbient = api;
}(typeof self !== 'undefined' ? self : this, () => {
  function between(random, min, max) {
    return min + random() * (max - min);
  }

  // frame-rate independent easing toward a target
  function approach(value, target, rate, dt) {
    return value + (target - value) * (1 - Math.exp(-rate * dt));
  }

  function clampUnit(value) {
    return Math.max(-1, Math.min(1, value));
  }

  function createAmbient({ random = Math.random } = {}) {
    let last = null;
    let calm = false;
    let nextEarAt = 0;
    let tailLift = 0; // steady raise added on top of the drift, e.g. while travelling
    let tailLiftTarget = 0;
    const ears = {
      left: { value: 0, target: 0, releaseAt: 0 },
      right: { value: 0, target: 0, releaseAt: 0 },
    };
    const tail = { value: 0, target: 0, rate: 1.5, releaseAt: 0, nextAt: 0, wagFrom: 0, wagUntil: 0 };

    function stepEars(now, dt) {
      if (!calm && now >= nextEarAt) {
        const pick = random();
        const sides = pick < 0.2 ? ['left', 'right'] : pick < 0.6 ? ['left'] : ['right'];
        const amount = (random() < 0.5 ? -1 : 1) * between(random, 0.4, 1);
        for (const side of sides) {
          ears[side].target = amount;
          ears[side].releaseAt = now + between(random, 120, 320);
        }
        nextEarAt = now + between(random, 2000, 7000);
      }
      for (const ear of Object.values(ears)) {
        if (calm || (ear.target !== 0 && now >= ear.releaseAt)) ear.target = 0;
        ear.value = approach(ear.value, ear.target, ear.target !== 0 ? 18 : 6, dt); // snap out, relax back
      }
    }

    function stepTail(now, dt) {
      if (!calm && now >= tail.nextAt) {
        const roll = random();
        if (roll < 0.15) {
          tail.target = random() < 0.5 ? -1 : 1; // flick
          tail.rate = 10;
          tail.releaseAt = now + 250;
        } else if (roll < 0.35) {
          tail.wagFrom = now; // happy wag: a few quick swings
          tail.wagUntil = now + 1400;
          tail.releaseAt = 0;
        } else {
          tail.target = between(random, -0.6, 0.6); // lazy drift
          tail.rate = 1.5;
          tail.releaseAt = 0;
        }
        tail.nextAt = now + between(random, 3000, 9000);
      }
      if (tail.releaseAt && now >= tail.releaseAt) {
        tail.target = between(random, -0.3, 0.3);
        tail.rate = 3;
        tail.releaseAt = 0;
      }
      if (tail.wagUntil) {
        if (now < tail.wagUntil && !calm) {
          const seconds = (now - tail.wagFrom) / 1000;
          tail.target = 0.5 * Math.sin(seconds * 2 * Math.PI * 2.2);
          tail.rate = 14;
        } else {
          tail.wagUntil = 0;
          tail.target = between(random, -0.3, 0.3);
          tail.rate = 3;
        }
      }
      if (calm) {
        tail.target = 0;
        tail.rate = 3;
      }
      tail.value = approach(tail.value, tail.target, tail.rate, dt);
      tailLift = approach(tailLift, calm ? 0 : tailLiftTarget, 3, dt);
    }

    function step(now) {
      if (last === null) {
        last = now;
        nextEarAt = now + between(random, 1000, 4000);
        tail.nextAt = now + between(random, 500, 3000);
      }
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      stepEars(now, dt);
      stepTail(now, dt);
      return {
        earLeft: clampUnit(ears.left.value),
        earRight: clampUnit(ears.right.value),
        tailSway: clampUnit(tail.value + tailLift),
      };
    }

    return {
      step,
      setCalm(value) {
        calm = !!value;
      },
      setTailLift(value) {
        tailLiftTarget = clampUnit(Number(value) || 0);
      },
    };
  }

  return { createAmbient };
}));
