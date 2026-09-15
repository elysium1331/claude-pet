# Celestial Fox — Batch 6, facing correction and ambient controls

**Runtime file:** `celestial-fox.riv` · **Artboard:** `CelestialFox` · **State machine:** `PetStateMachine` · **View model:** `PetController` (default instance).

One transparent **560 × 600** artboard. Batches 1–6 are implemented. Batch 6 corrects settled left-facing silhouettes and adds three additive ambient Number controls. All 16 state values, 31 triggers, existing property names/IDs/defaults, public animation timelines and existing state transitions are preserved. Only internal facing helpers and the requested additive layers change.

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
| 9 | `working_busy` | 2.5 s, loop | Alternating fin typing on a small glowing work pad, focused nod and key pulses |
| 10 | `confused` | 3 s, loop | Puzzled head sway, asymmetric brows, searching eyes and question/swirl motes |
| 11 | `disconnected` | 4 s, loop | Looking around for a connection, broken-link mote, cloudy grey meters in a closer orbit |
| 12 | `chasing` | 2 s, loop | Floating pursuit with paddling fins and swishing tail; faces the `facing` direction. The host moves the canvas toward the cursor |
| 13 | `sitting` | 5 s, loop | Upright ground pose with a coiled celestial tail, breathing, content eyes, slow blink and ear flick |
| 14 | `walking` | 1.2 s, seamless loop | Low ground glide/trot, alternating fin paddles and swaying tail, facing the selected direction; host moves the window |
| 15 | `floating_travel` | 2 s, seamless loop | Relaxed forward drift, gentle bob and streaming tail; host moves the window |

States 4 and 5 remain the original one-shot-and-hold states to retain compatibility. Re-selecting an already selected state does not restart its timeline. To replay 4 or 5, briefly select another state, then select it again. All states can transition to each other, with an internal settling stage when entering lounging. New activity states use 240 ms blends; grounded transitions can use 360 ms. Existing blends remain 180 ms (320 ms entering sleeping/tired). Lounging uses a short staged settling motion: meters move aside before the body lowers, with 180–360 ms blends. When waking, the head rises before the meters return to the floating orbit.

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
| `alertRing` | 1.2 s | Yes; small startle | Selected state; sharp bell ring. App selects `state = 3` to hold attention afterward |
| `approve` | 1.2 s | No; head and eyes | Selected state; happy nod and soft squint |
| `taskDone` | 2.5 s | Yes | Selected state; celebration bounce, checkmark bubble and sparkle burst |
| `error` | 1.5 s | Yes | Selected state; small flinch, squeezed eyes and oops motes |
| `usageReset` | 2.5 s | Yes | Selected state; stretch while all three arcs drain, flash and refill to their live app-supplied values |
| `limitHit` | 2 s | Yes | Selected state; deflated sigh while the highest-usage orb fills to full temporarily. App selects `state = 7` afterward |
| `greet` | 2 s | No; fin and head | Selected state; friendly repeated wave beside the head |
| `goodbye` | 1.5 s | No; fin and head | Selected state; smaller wave. App fires `disappear` afterward |
| `petted` | 2 s | Yes; gentle wiggle | Selected state or held pose; happy squint, warm sparkles and tail wiggle |
| `tickled` | 1.5 s | Yes | Selected state or held pose; giggly squirm and quick head/body wiggles |
| `eat` | 2 s | No; expression and fin | Selected state or held pose; a glowing spark approaches the mouth, then happy chewing and a small glow pulse |
| `catchOrb` | 1.5 s | No; head and fin | Selected state or held pose; catches an incoming decorative spark. Usage meters remain intact |
| `land` | 0.8 s | Yes | Drops to y=590, squashes and settles, then blends back to the selected state or held pose |
| `bonk` | 1 s | Yes; brief recoil | Selected state or held pose; small sideways recoil, dizzy stars and a shake |
| `dizzy` | 2 s | Yes; small sway | Selected state or held pose; wobble and stars after shaking |
| `trickSpin` | 1.5 s | Yes | Selected state or held pose; a compact loop-de-loop above the meter orbit |
| `trickFlip` | 1.5 s | Yes | Selected state or held pose; a compact somersault above the meter orbit |
| `levelUp` | 3 s | Yes | Selected state or held pose; luminous burst, proud lift, spread fins and happy eyes. Does not change growth |



Visibility has its own animation layer and can run alongside fidgets. `disappear` intentionally hides the whole pet, including meters, as required by its fully invisible endpoint. If `statsOpen` remains true, `appear` restores the pet with the meters still hidden for the stats panel. `perkUp` does not cancel a latched `disappear`; call `appear` to unhide.

## All view-model properties (54)

| Property | Type | Range | Default | Effect |
|---|---|---|---|---|
| `state` | Number | Integer 0–15 | `0` | Persistent state selector |
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
| `alertRing` | Trigger | Event | Not fired | Bell/startle reaction |
| `approve` | Trigger | Event | Not fired | Happy nod reaction |
| `taskDone` | Trigger | Event | Not fired | Celebration/checkmark reaction |
| `error` | Trigger | Event | Not fired | Flinch/oops reaction |
| `usageReset` | Trigger | Event | Not fired | Drain/flash/refill reaction; preserves usage data |
| `limitHit` | Trigger | Event | Not fired | Sigh/full-meter reaction; preserves usage data and state |
| `greet` | Trigger | Event | Not fired | Friendly wave |
| `goodbye` | Trigger | Event | Not fired | Small wave; does not hide by itself |
| `held` | Boolean | false / true | `false` | Temporarily overrides the base pose with dangling fins/tail and surprised eyes; preserves `state` |
| `dragLean` | Number | −1 to 1 | `0` | While held, leans opposite the drag direction, up to about 9°; visually clamped |
| `facing` | Number | `−1` or `1` | `1` | Left/right direction in every state and while held; changing direction plays an approximately 350 ms dimensional turn |
| `happiness` | Number | 0–100 | `50` | Subtle eye/brow and warm-heart changes in resting states 0, 8 and 13. Default 50 preserves the existing appearance |
| `petted` | Trigger | Event | Not fired | Purring wiggle and warm sparkles |
| `tickled` | Trigger | Event | Not fired | Giggly squirm |
| `eat` | Trigger | Event | Not fired | Spark gobble, chew and glow pulse |
| `catchOrb` | Trigger | Event | Not fired | Catch a decorative spark |
| `land` | Trigger | Event | Not fired | Ground squash and settle |
| `bonk` | Trigger | Event | Not fired | Recoil and dizzy stars |
| `dizzy` | Trigger | Event | Not fired | Wobble and stars |
| `trickSpin` | Trigger | Event | Not fired | Loop-de-loop |
| `trickFlip` | Trigger | Event | Not fired | Somersault |
| `levelUp` | Trigger | Event | Not fired | Celebration burst and proud pose |
| `growth` | Number | Integer 0–3 | `0` | Cumulative cosmetic tiers: base, longer wisps, extra pearl/stars, then a halo/crown |
| `palette` | Number | Integer 0–3 | `0` | 0 celestial blue/peach, 1 rose/gold, 2 mint/aqua, 3 violet/silver |
| `nightMode` | Boolean | false / true | `false` | Softer, dimmer character lights; preserves the readable meters and dark legibility outlines |
| `sniff` | Trigger | Event | Not fired | 2 s curious ground/air sniff |
| `lookBack` | Trigger | Event | Not fired | 1.5 s glance opposite the selected facing direction |
| `happyHop` | Trigger | Event | Not fired | 1 s excited arrival hop |
| `earLeft` | Number | −1…1 | `0` | Additive rotation of the pet’s own left ear around its base; negative folds back/down, positive perks forward/up |
| `earRight` | Number | −1…1 | `0` | Independent additive rotation of the pet’s own right ear, with the same fold/perk meaning |
| `tailSway` | Number | −1…1 | `0` | Additive tail-bone curl: negative dips, positive lifts; tip follows the chain |


Supply usage data and colors from the app; the file makes no network requests. Rings fill clockwise from the top. `0` is empty/dim and `100` is full. Decimal percentages work, and visual fill clamps to 0–100. **Built-in calm/amber/red banding is disabled.** Each Color property independently drives its meter's fill ring and ring glow, plus its soft halo/core illumination. Changing a usage Number changes the fill amount, not the ring color. The app supplies its own blue → yellow → orange → red interpolation and timing; color updates are immediate in the file. Set opaque RGB colors for normal use; color alpha also modulates the colored artwork. Glow has an additional fixed soft falloff. The 1/2/3-dot marks remain opaque white (`#FFFFFF`), upright, and independent of the supplied color. On the front arc at 140 × 150, each meter shell is approximately 20 px across and the fill ring approximately 2.2 px thick. The back arc eases to approximately 17 px across; dot marks scale with the orb and keep their white paint.

The three Color defaults are opaque `#B7E7FF` (`0xFFB7E7FF` as packed ARGB), serving only as initial fallback values. The app should set all three after loading. Neutral shell/empty-track colors remain unchanged. The old threshold overlay objects are retained, disabled, to preserve their existing IDs.

In `disconnected`, only the rendered meter artwork becomes grey/cloudy; all app-owned usage and Color properties remain unchanged. The 24 s orbit retains its tighter 120 px horizontal radius and 48 px vertical radius, with the new back/front depth treatment. On exit, the latest app-supplied colors are restored automatically, including changes made while disconnected. White dot marks stay visible.

`usageReset` multiplies the current usage arcs through vector trim effects: drain, flash, then refill to the latest usage values. It never writes usage Numbers or Color properties. `limitHit` adds the missing arc to the highest-usage meter temporarily; ties prefer session, then weekly, then fable. The arc returns to the live usage value when the reaction finishes. The app should supply the actual reached usage (usually 100) if it must stay full, and select `state = 7` for persistent tired behavior. All eight new triggers leave `state` unchanged.

The regular independent meter orbit lasts 24 s. Lounging retains its slower 36 s orbit: the front route circles the tail on the left, while the back route curves behind the head/body. Sitting and walking use a lower 24 s orbit. The back/front draw-order swap occurs at the unobstructed side junctions, using the original meter subtrees rather than duplicate artwork. Meters remain independent of tired-state dimming, expression changes and one-shot state holds. Decorative pearls and antenna tips remain vector artwork.

On each back arc, scale eases from full size at the side to 85% at the farthest point, and opacity/brightness eases to 70%. The front arc stays at full size and brightness. Returning smoothly to full size at each side avoids a scale or brightness jump when draw order changes. Front routes avoid the eyes/face; back routes can pass behind the pet. Stats merging temporarily brings meters to the front at full size/brightness, then restores depth. The existing landing reaction retains its safe staged meter route. App-controlled fills, colors, disconnected grey and cosmetics compose with depth.

`statsOpen` uses a 400 ms eased route: outside the face, toward the selected meeting point, then a bright merge bubble and fade. Closing reverses the route. Rapid reversals blend for 180 ms. Set `statsSide` before changing `statsOpen`; changing the side while already open relocates the hidden meeting point immediately. Cursor input is clamped visually to −1…1. Screen-positive `lookY` looks down. Hover blends in/out over 240 ms.

Meeting points, in artboard pixels:

| Pose | Above head, `statsSide = 0` | Below tail, `statsSide = 1` |
|---|---|---|
| States 0–7, 9–12, 14 and 15 | `(280, 45)` | `(280, 580)` |
| Lounging, state 8 | `(310, 365)` | `(100, 580)` |
| Sitting, state 13 | `(320, 305)` | `(320, 580)` |
| Held, any selected state | `(280, 45)` | `(280, 580)` |

The named transform `stats_meeting_point` is exported for hosts that need its world position. During a state transition, let the panel follow the intended destination pose rather than assuming a constant anchor.

## Dragging, chasing and play

`held = true` temporarily takes priority over the selected base state and moves into a floating dangling pose with its own 3 s swaying loop. Reactions, stats controls, hover and gaze remain available. `held = false` blends back to the app’s latest selected state, even if `state` changed during the drag. No new Batch 3 trigger writes `state`, `held`, usage, colors or happiness.

Set `dragLean` from drag velocity/direction, with screen-right positive. The character leans in the opposite direction. Facing now applies in every state, including sitting, lounging, walking, floating travel and held. The host owns cursor tracking, canvas position, edge detection, click counts and reaction scheduling. The file does not move an OS window or calculate cursor pursuit. Chasing is the floating alternative requested in the specification and does not touch the ground.

On release, set `held = false`, select the desired persistent destination, and fire `land`. Landing briefly uses a compact contact pose on y=590, with meters staged to the left, then returns to the selected pose. Choose state 13 before landing if the pet should remain on the ground. The landing contact is around x=350 to keep the face away from the readable meters. Full-body landing/tricks add a 400 ms return blend to their authored durations; other reactions add up to 180 ms.

Tricks tuck the character into a smaller pose above the meters and return to the live destination pose. Internal full-turn angle normalization resets an equivalent 360° angle to 0° with no visible pose change. `catchOrb` uses a separate decorative spark; it never consumes a usage meter. `levelUp` is a reaction only. The app can set `growth` and fire `levelUp` together; the trigger does not award a tier by itself.

## Turning and roaming

Set `facing = -1` for left and `facing = 1` for right. A direction change plays a 21-frame (350 ms) turn with side-profile compression, three-quarter projection, facial parallax, independent ear/fin motion, body/head rotation and a tail sweep. Only intermediate turn frames use profile compression. The settled left pose is now the full reflected visual counterpart of the right pose, including head angle, both ears/fins and full tail length. Both sides have identical character silhouette dimensions. The approximately 350 ms dimensional turn remains in place; a settled direction change is not an instantaneous mirror flip. Right-facing defaults retain the original pose. The orbs, white dot marks, sleep marks and other symbols are never mirrored. Rapid direction reversals blend into the opposite turn.

Floating poses get a tiny turn hop. Sitting, lounging and walking turn in place; the lounging tail sweeps along its ground plane. The selected state, usage data, cosmetic settings and one-shot holds continue during a turn. The `facing` property remains a Number with its original ID/default; supply only −1 or 1.

Idle/sitting ↔ walking and idle ↔ floating travel use 300 ms blends. Walking → sitting includes a short 300 ms contact settle that blends into the unchanged sitting loop. The artboard never translates itself across the desktop: the app owns position, velocity, collision handling and stopping decisions.

| Trigger | Authored duration | Gesture / return |
|---|---:|---|
| `sniff` | 2 s | Curious head dip and small repeated sniff/breath pulses; returns to the selected pose |
| `lookBack` | 1.5 s | Head/ear glance toward the opposite direction of travel; direction is sampled when fired |
| `happyHop` | 1 s | Small squash, excited hop and happy eyes, then settles back |

These three triggers use the existing interruptible reaction system, enter over 100 ms, and return over up to 180 ms. They do not change any app-owned properties. They work while held as well. Example: select `state = 14` and set `facing` before moving the window; on arrival, stop the window, select `state = 13`, and fire `happyHop` when the settle has finished. Use `state = 15` for a longer floating trip.

## Ambient ear and tail controls

Set `earLeft`, `earRight` and `tailSway` directly through `PetController.number(name).value`. Each defaults to 0 and accepts −1…1; values outside that range are clamped. The app supplies smoothed values. The file adds no easing, delay or spring: the current value is applied in the same animation advance. At zero, these layers are identity transforms.

Ear identity is anatomical and stays attached to the same rig ear when facing changes. Each ear rotates about its established base pivot, independently of its state and reaction animation. Fold uses approximately 25°; perk uses approximately 20° to keep the large ear tips inside the original artboard envelope. The confused head-tilt loop uses about 16° at full perk to protect the upper edge. Sleeping and lounging use 40% of these offsets.

The three original tail bones receive distributed additive offsets (approximately 3°, 10° and 15°), with the tip following. The sitting coil receives a smaller 4° curl. Sleeping and lounging use 40% strength. The lounging chain reverses its local rotation sign so positive still lifts on its ground plane. Downward travel is restrained near the ground: limit_reached, chasing, walking and floating_travel use 35% of the normal negative tail range; lounging uses 15% before its 40% pose factor. These are direct proportional offsets, without dead zones. This keeps the established canvas bounds and prevents a downward tail from leaving the artboard.

Ambient offsets are ignored while `held = true`, during `trickSpin`, `trickFlip` and `land`, and through their authored return to the pose. Values remain stored, and resume when that override ends. Other reactions retain the additive ear/tail motion. The existing gaze and drag controls retain their screen-space directions on either facing side. Usage meters, white dot marks and symbols remain upright.

```js
const vm = pet.viewModelInstance;
vm.number('earLeft').value = 0.6;
vm.number('earRight').value = -0.2;
vm.number('tailSway').value = 0.4;
vm.number('facing').value = -1;
```

## Cosmetics

All cosmetic changes use the existing rig and keep the 560 × 600 artboard. Growth and palette changes blend over 300 ms; night mode blends over 400 ms. Defaults (`growth = 0`, `palette = 0`, `nightMode = false`) retain the earlier appearance. Reactions, held, stats, gaze and hover continue to work with cosmetics enabled.

| Growth | Added details, cumulative |
|---:|---|
| 0 | Base pet from Batches 1–3 |
| 1 | Longer peach and blue tail wisps, skinned to the existing tail bones; a matching extra sweep on the sitting tail |
| 2 | One additional antenna pearl and brighter star details attached to the moving ears and head |
| 3 | Soft elliptical halo and small crown rays between the ears |

| Palette | Character colors |
|---:|---|
| 0 | Celestial blue / peach; original paint values |
| 1 | Rose / gold |
| 2 | Mint / aqua |
| 3 | Violet / silver |

Palettes preserve the authored transparency and lightness relationships. The dark translucent legibility rim/under-shadow retains its deep-blue contrast treatment. **Usage meters are excluded from palette and night-mode changes.** `sessionColor`, `weeklyColor` and `fableColor` remain app-controlled; there is no restored automatic warning banding. The white 1/2/3-dot marks remain white. State 11 continues to render its temporary grey connection treatment and restores the latest app colors on exit.

Night mode reduces soft radial light to about 48% intensity, star fields to 60%, and eye/halo highlights to 78%, through opacity wrappers. It adds no blur effect, does not dim the usage data, and does not paint a background. It composes with `lightBackdrop`, sleeping/tired dimming, happiness, visibility and growth. The app owns time-of-day scheduling and tier persistence; the `.riv` has no clock, storage or usage-fetching code.

Supply integer `growth` and `palette` values in 0–3. Values outside that set have no defined new selection; use the documented values rather than tweening these selector Numbers. The file handles the visual blend after a valid selection.

## Ground and visible bounds

Ground contact is authored at **y = 590**. A small luminous rim/under-shadow may extend several pixels beyond the contact contour. Keep the 560 × 600 artboard's full layout box; do not trim each animation to its silhouette.

Approximate visible bounds include meters, decoration, and glow with alpha ≥ 16/255, sampled across the independent orbit and pose loops. Coordinates are **left / top / right / bottom** in artboard pixels; soft outermost glow can extend a little farther.

| Idle / facing | Growth 3, all ambient controls = 1 |
|---|---|
| Right | `68 / 4 / 492 / 510` |
| Left | `68 / 4 / 492 / 510` |

Values are left / top / right / bottom on the 560 × 600 artboard, with exclusive right/bottom coordinates. They include sampled idle phases and a complete 24-second meter orbit, using alpha ≥ 16/255. Both faces use the full silhouette. These Batch 6 measurements replace the obsolete compressed-left measurements. Keep the complete artboard and the y = 590 ground reference; do not crop or rescale individual states.

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
    vm.number('growth').value = 3;
    vm.number('palette').value = 0;
    vm.boolean('nightMode').value = false;
    vm.trigger('appear').trigger();
  },
});

// After onLoad:
// pet.viewModelInstance.number('state').value = 12; // Host moves the canvas
// pet.viewModelInstance.number('facing').value = -1;
// pet.viewModelInstance.boolean('held').value = true;
// pet.viewModelInstance.number('dragLean').value = 0.7;
// On release: set held=false, select state=13, then trigger('land').trigger().
// pet.viewModelInstance.trigger('petted').trigger();
// pet.viewModelInstance.number('happiness').value = 80;
// pet.viewModelInstance.number('state').value = 9; // Working with tools
// pet.viewModelInstance.trigger('taskDone').trigger();
// pet.viewModelInstance.trigger('usageReset').trigger();
// pet.viewModelInstance.number('state').value = 11; // Disconnected
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

## Batch 6 verification and source

Verified with the official `@rive-app/webgl2 2.42.1` runtime, including the high-level `Rive` / `autoBind` Number-property interface. The source archive includes machine-readable reports for counterpart transforms, zero-offset comparisons against Batch 5, direct ambient application, override gates, all existing triggers, stats merging and orbit face clearance.

Contact sheets show all 16 states plus held, left next to right, on dark and white backgrounds at 560 × 600 and 140 × 150 per cell. The two 12-second GIFs show right/left idle at growth 3. Each runs earLeft, earRight, tailSway, then all three together, sweeping through −1 and +1 and returning to zero; dark and white views appear side by side. The GIF replay resets orbit phase because the clip is shorter than the full 24-second orbit.

The source ZIP contains editable `scene.rml`, `rive.yaml`, this map, all generator modules and verification reports. Compile the RML project using Rive CLI 1.0.3: `rive . --once`. No images, fonts, audio, scripts or external assets are embedded in the `.riv`. This is a runtime `.riv` plus editable RML source, not an editor `.rev` project.
