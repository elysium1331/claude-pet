# Celestial Fox — revision 4, Batch 1

**Runtime file:** `celestial-fox.riv` · **Artboard:** `CelestialFox` · **State machine:** `PetStateMachine` · **View model:** `PetController` (default instance).

One transparent **560 × 600** artboard. Batch 1 adds desktop life controls; Batches 2–4 are not implemented in this delivery. Existing names, IDs, state values 0–7, all eight original animation definitions, the `usage_orbit` timeline, and all 56 original state transitions are preserved.

## Persistent states

Set the Number property `state` to an integer. The selected state remains active until changed by the app, except that `perkUp` explicitly sets it to `0`.

| State | Animation | Duration | Behavior |
|---:|---|---|---|
| 0 | `idle` | 4 s, loop | Floating, blinking, gentle ears and tail |
| 1 | `sleeping` | 6 s, loop | Closed eyes, breathing, relaxed ears, sleep marks |
| 2 | `working_thinking` | 3 s, loop | Head tilt, raised brow, pulsing thought motes |
| 3 | `needs_attention` | 3 s, loop | Bell bubble and swinging bell |
| 4 | `done_happy` | 2.5 s, then holds | Happy bounce, squint, checkmark bubble; original playback preserved |
| 5 | `idea` | 2.5 s, then holds | Lift, bright eyes, lightbulb bubble; original playback preserved |
| 6 | `low_usage_worry` | 4 s, loop | Worried brows/mouth, lowered ears |
| 7 | `limit_reached` | 6 s, loop | Dim, lowered, tired floating pose |
| 8 | `lounging` | 8 s, loop | Grounded body and chin, half-closed slow blinks, breathing, ear flick, lazy tail swish |

States 4 and 5 remain the original one-shot-and-hold states to retain compatibility. Re-selecting an already selected state does not restart its timeline. To replay 4 or 5, briefly select another state, then select it again. All states connect directly to each other. Existing blends remain 180 ms (320 ms entering sleeping/tired). Lounging uses a short staged settling motion: meters move aside before the body lowers, with 180–360 ms blends. When waking, the head rises before the meters return to the floating orbit.

## Reactions — view-model triggers

Call `pet.viewModelInstance.trigger(name).trigger()` after loading and binding the default instance. Each trigger can be fired repeatedly. Reactions layer over the currently selected state; the underlying state and meter orbit continue advancing. A new fidget can interrupt the previous fidget with a 180 ms blend. Schedule one fidget at a time when the full gesture should finish.

Durations below are authored timeline lengths. The automatic blend back can add approximately 180 ms. Reactions finish at neutral wrapper transforms, revealing the current pose of the selected state.

| Trigger | Duration | Full-body involvement | Returns to / final behavior |
|---|---:|---|---|
| `lookAround` | 3 s | No; eyes and head | Selected state; left/right/up glances, then centered |
| `stretch` | 3 s | Yes | Selected state; body elongates, ears fold back, fins extend, tail flicks |
| `yawn` | 2.5 s | No; head and expression | Selected state; mouth opens, eyes squeeze, then relax |
| `orbPlay` | 3.5 s | Yes; lean and batting fin | Selected state; playful batting gesture toward the meter orbit |
| `tailChase` | 3 s | Yes | Selected state; a turn through side and mirrored views follows the tail |
| `scratchEar` | 2 s | No; fin and head | Selected state; repeated fin-to-ear scratches |
| `sneeze` | 1.5 s | Yes | Selected state; anticipation, squash/flinch, tiny vector sparkle puff |
| `perkUp` | 1.5 s | Yes | **Sets `state = 0` inside the file**, wakes and hops into idle; works from sleeping/lounging and other states |
| `appear` | 1 s | Whole character visibility | Restores selected state and meters with vector sparkles |
| `disappear` | 0.8 s | Whole character visibility | **Holds completely invisible** until `appear`; keeps the selected state value |

Visibility has its own animation layer and can run alongside fidgets. `disappear` intentionally hides the whole pet, including meters, as required by its fully invisible endpoint. If `statsOpen` remains true, `appear` restores the pet with the meters still hidden for the stats panel. `perkUp` does not cancel a latched `disappear`; call `appear` to unhide.

## All view-model properties

| Property | Type | Range | Default | Effect |
|---|---|---|---|---|
| `state` | Number | Integer 0–8 | `0` | Persistent state selector |
| `session` | Number | 0–100 | `0` | One-dot usage meter |
| `weekly` | Number | 0–100 | `0` | Two-dot usage meter |
| `fable` | Number | 0–100 | `0` | Three-dot usage meter |
| `sessionColor` | Color | RGBA color; RGB channels 0–255 | `#B7E7FF` (opaque) | Session meter fill ring, ring glow, and soft orb illumination |
| `weeklyColor` | Color | RGBA color; RGB channels 0–255 | `#B7E7FF` (opaque) | Weekly meter fill ring, ring glow, and soft orb illumination |
| `fableColor` | Color | RGBA color; RGB channels 0–255 | `#B7E7FF` (opaque) | Fable meter fill ring, ring glow, and soft orb illumination |
| `lightBackdrop` | Boolean | false / true | `false` | Stronger translucent dark rim and deep-blue under-shadow for white windows |
| `statsOpen` | Boolean | false / true | `false` | Merge/pop/hide meters when true; split them back into orbit when false |
| `statsSide` | Number | `0` or `1` | `0` | Meeting point above head (`0`) or below tail (`1`) |
| `hovered` | Boolean | false / true | `false` | Subtle ear perk and brighter eyes; no body or orbit change |
| `lookX` | Number | −1 to 1 | `0` | Eyes follow horizontally; slight head shift and turn |
| `lookY` | Number | −1 to 1 | `0` | Eyes follow vertically; slight head shift |
| `lookAround` | Trigger | Event | Not fired | Reaction above |
| `stretch` | Trigger | Event | Not fired | Reaction above |
| `yawn` | Trigger | Event | Not fired | Reaction above |
| `orbPlay` | Trigger | Event | Not fired | Reaction above |
| `tailChase` | Trigger | Event | Not fired | Reaction above |
| `scratchEar` | Trigger | Event | Not fired | Reaction above |
| `sneeze` | Trigger | Event | Not fired | Reaction above |
| `perkUp` | Trigger | Event | Not fired | Reaction above; writes `state = 0` |
| `appear` | Trigger | Event | Not fired | Restore visibility |
| `disappear` | Trigger | Event | Not fired | Hide and hold |

Supply usage data and colors from the app; the file makes no network requests. Rings fill clockwise from the top. `0` is empty/dim and `100` is full. Decimal percentages work, and visual fill clamps to 0–100. **Built-in calm/amber/red banding is disabled.** Each Color property independently drives its meter's fill ring and ring glow, plus its soft halo/core illumination. Changing a usage Number changes the fill amount, not the ring color. The app supplies its own blue → yellow → orange → red interpolation and timing; color updates are immediate in the file. Set opaque RGB colors for normal use; color alpha also modulates the colored artwork. Glow has an additional fixed soft falloff. The 1/2/3-dot marks remain opaque white (`#FFFFFF`), upright, and independent of the supplied color. At 140 × 150, each meter shell is approximately 20 px across and the fill ring approximately 2.2 px thick.

The three Color defaults are opaque `#B7E7FF` (`0xFFB7E7FF` as packed ARGB), serving only as initial fallback values. The app should set all three after loading. Neutral shell/empty-track colors remain unchanged. The old threshold overlay objects are retained, disabled, to preserve their existing IDs.

The regular independent meter orbit lasts 24 s. Lounging switches to a slower 36 s orbit, lower and to the left of the resting face. Meters are independent of the tired-state dimming, expression changes, and one-shot state holds. Decorative pearls and antenna tips remain vector artwork.

`statsOpen` uses a 400 ms eased route: outside the face, toward the selected meeting point, then a bright merge bubble and fade. Closing reverses the route. Rapid reversals blend for 180 ms. Set `statsSide` before changing `statsOpen`; changing the side while already open relocates the hidden meeting point immediately. Cursor input is clamped visually to −1…1. Screen-positive `lookY` looks down. Hover blends in/out over 240 ms.

Meeting points, in artboard pixels:

| Pose | Above head, `statsSide = 0` | Below tail, `statsSide = 1` |
|---|---|---|
| Floating states 0–7 | `(280, 45)` | `(280, 580)` |
| Lounging, state 8 | `(310, 365)` | `(100, 580)` |

The named transform `stats_meeting_point` is exported for hosts that need its world position. During a state transition, let the panel follow the intended destination pose rather than assuming a constant anchor.

## Ground and visible bounds

Ground contact is authored at **y = 590**. A small luminous rim/under-shadow may extend several pixels beyond the contact contour. Keep the 560 × 600 artboard's full layout box; do not trim each animation to its silhouette.

Approximate visible bounds include meters, decoration, and glow with alpha ≥ 16/255, sampled across the independent orbit and pose loops. Coordinates are **left / top / right / bottom** in artboard pixels; soft outermost glow can extend a little farther.

| Pose | Approximate bounds | Status |
|---|---|---|
| Floating idle | `69 / 27 / 491 / 553` | Batch 1 |
| Lounging | `10 / 397 / 451 / 598` | Batch 1 |
| Sitting | — | Scheduled for Batch 3; not implemented |
| Held | — | Scheduled for Batch 3; not implemented |
| Chasing | — | Scheduled for Batch 3; not implemented; `tailChase` is a separate reaction |

## Integration with @rive-app/webgl2 2.42.1

```js
import { Rive, Layout, Fit, Alignment } from '@rive-app/webgl2';

const pet = new Rive({
  src: '/celestial-fox.riv',
  canvas: document.querySelector('canvas'),
  artboard: 'CelestialFox',
  stateMachines: 'PetStateMachine',
  autoBind: true,
  autoplay: true,
  layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
  onLoad: () => {
    pet.resizeDrawingSurfaceToCanvas();
    const vm = pet.viewModelInstance;
    vm.number('session').value = 42;
    vm.number('weekly').value = 78;
    vm.number('fable').value = 94;
    vm.color('sessionColor').rgb(183, 231, 255);
    vm.color('weeklyColor').rgb(255, 208, 139);
    vm.color('fableColor').rgb(255, 153, 124);
    vm.boolean('lightBackdrop').value = true; // White/light window
    vm.trigger('appear').trigger();
  },
});

// After onLoad:
// pet.viewModelInstance.number('state').value = 8;
// pet.viewModelInstance.trigger('yawn').trigger();
// pet.viewModelInstance.trigger('perkUp').trigger(); // Also sets state = 0
// pet.viewModelInstance.number('statsSide').value = 1;
// pet.viewModelInstance.boolean('statsOpen').value = true;
// pet.viewModelInstance.boolean('hovered').value = true;
// pet.viewModelInstance.number('lookX').value = 0.5;
// pet.viewModelInstance.number('lookY').value = -0.2;
// Supply the app's latest interpolated ring color (RGB bytes):
// pet.viewModelInstance.color('sessionColor').rgb(255, 144, 60);
// Packed ARGB is also supported: vm.color('sessionColor').value = 0xFFFF903C;
// On resize: pet.resizeDrawingSurfaceToCanvas();
// On teardown: pet.cleanup();
```

Runtime caveats:

- Use the view model's Trigger objects, not `stateMachineInputs()` or `pet.play('yawn')`. Direct animation playback bypasses the reaction layers and automatic return behavior.
- Run `PetStateMachine` as the animation controller. Underscore-prefixed timelines are internal blend/rest/route helpers.
- Do not continuously rewrite `state = 8` or `state = 1` every frame while firing `perkUp`; that would override its intentional return to idle.
- Invalid state values have no defined selection. Supply integer states and `statsSide` values from the documented ranges.
- Animation advances must continue through disappear until its 0.8 s fade completes; then the host can pause/hide the canvas. Resume before firing `appear`.
- Gaze and hover are layered transforms. A closed-eye loop stays closed while gazing or hovering; hover does not replace its expression.
- At small display sizes, use a device-pixel-ratio-sized drawing surface and the complete artboard aspect ratio. `lightBackdrop` strengthens the character's rim/shadow without painting a background.
- Pause when the host window is genuinely offscreen. Respect reduced-motion preferences by letting a selected pose settle and then pausing. The file contains no timer, app scheduling, or usage fetching logic.

## Source and previews

`celestial-fox-source.zip` contains editable RML artwork, rig, timelines, data bindings, state machine, `rive.yaml`, this map, and verification reports. Compile from that source with **Rive CLI 1.0.3** (or compatible newer tooling): `rive . --once`. The `.riv` is the compiled runtime deliverable. An editor `.rev` file is not included.

Artwork uses only vector paths, gradients, transforms, and a three-bone skinned tail. There are no embedded images, fonts, audio, scripts, or external runtime assets. The file stays below 100 KB, comfortably below the requested approximately 400 KB limit.

Four contact sheets show every new loop/reaction, with individual cells rendered directly at 560 × 600 or 140 × 150 in WebGL2 2.42.1. White previews enable `lightBackdrop`. All previews use sample usage 42/78/94, with the app explicitly supplying colors `#B7E7FF`, `#FFD08B`, and `#FF997C`; these are preview choices, not automatic thresholds. The GIF pack contains one looping comparison clip per new animation, with dark and white versions side by side. GIF repetition is a preview convenience: reactions remain one-shot in the `.riv`, and disappear holds invisible until appear.

Color add-on verification in **@rive-app/webgl2 2.42.1: 345/345 checks passed**. Rendered pixels confirmed four live colors for each ring and its glow across all nine states, white identity dots, and unchanged app-selected colors across the former 70/90 thresholds. The public high-level `viewModelInstance.color(name).rgb(r,g,b)` API was also checked. `verification/color-bindings-webgl2-2.42.1.json` records those results. The glow checks compare hue independently from its intentional brightness falloff.

Validation reports accompany the source: **387/387 web-runtime checks passed**, covering all nine states, repeated firing of all ten triggers across those states, property behavior, disappearance/restoration, and sampled meter-to-face clearance during reactions and lounging transitions. Structural checks confirm all prior named IDs, all 32 Batch 1 timelines, and all 81 existing pet-state transitions remain intact. A 600-frame native render benchmark on this machine measured approximately 0.05 ms mean animation advance and 0.23 ms mean rendering; these are local native measurements, not a guarantee for a particular browser/GPU.



