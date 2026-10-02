# Flight Events Without the Popup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flight events never pause the flight or ask a question; the two that remain apply a fixed outcome with a caution chip, and emergency coolant becomes a one-charge control the pilot fires.

**Architecture:** Keep the data-driven `FlightEventService` + `flight_events.json`, but replace each event's `choices[]` with one `outcome`. `FlightScene` applies the outcome after the event's cinematic and shows a caution chip. Coolant logic is a small pure module (`Coolant.ts`) so it can be checked headlessly; the scene wires it to the C key and a contextual touch button.

**Tech Stack:** TypeScript 6, Phaser 3.90, React 19, Vite 8 (rolldown). No test framework in the repo — headless checks are bundled with `node_modules/.bin/rolldown` into a scratch directory and run with Node 22.

**Spec:** `docs/superpowers/specs/2026-10-02-flight-events-no-popup-design.md`

## Global Constraints

- No event may pause physics or show a choice. `eventModalOpen` and `RadioStrip` cease to exist.
- Remaining events: `bird_strike` (−10 integrity, +0.1 engineTemp, caution `BIRD STRIKE −10%`, 5 s) and `fuel_leak` (fuelBurnRate ×1.15, caution `FUEL LEAK`, rest of flight). `engine_overheating` and `distress_signal` are deleted.
- Coolant: `C` key / `COOLANT` touch button; one charge per flight; only fires when engineTemp > 0.72; sets engineTemp 0.40 and costs 2 integrity.
- No new permanent buttons or toasts (user: "too much buttons"). The touch COOLANT button appears only while the engine is hot and the charge is unused.
- Code style: match the surrounding files — explanatory block comments in the game's voice, `n()` scaling in styles, CRLF working-copy line endings (git stores LF).
- Do not commit unless the user asks.

## Review Focus

1. Event cinematic finishing after the flight ended (landed / crashing) — the outcome must not apply to a finished flight. Pinned by the guard in Task 2 Step 4 and the in-game check in Task 4.
2. Pressing C with a cool engine — must not spend the charge. Pinned by `tryDumpCoolant` test case `not-hot` in Task 3.
3. Pressing C twice — second press must report empty, not cool again. Pinned by test case `empty` in Task 3.
4. A fired event leaving the service locked (the old `pendingChoice` never cleared without a choice) — a later event must still be able to fire. Pinned by the "fires again after the gap" assertion in Task 1.
5. Starting a new flight after a fuel leak — the `FUEL LEAK` chip and the used coolant charge must not carry over. Pinned by the `init()` resets in Task 2/Task 3 and the in-game check in Task 4.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/types/event.ts` | Event data types | `choices` → `outcome`; delete `EventChoice`, `action`, `FlightAction` |
| `public/data/events/flight_events.json` | Event data | two events with outcomes |
| `src/services/FlightEventService.ts` | Trigger + apply events | `applyOutcome`, `force`; delete choice machinery |
| `src/game/entities/aircraft/Coolant.ts` | **new** — pure coolant rule | `tryDumpCoolant` |
| `src/game/utils/EventBus.ts` | Typed events | drop 5 popup events; `flight:status` gains `coolantLeft`, `eventCaution` |
| `src/game/scenes/FlightScene.ts` | Flight orchestration | apply outcomes, caution, coolant control, DEV keys; delete pause + `runEventAction` |
| `src/game/audio/SoundEngine.ts` | Sounds | `steamVent()` |
| `src/game/utils/controls.ts`, `src/game/utils/touchInput.ts` | Control naming / touch pulses | `coolant` |
| `src/ui/components/hud/FlightHUD.tsx`, `hudStyles.ts` | HUD | delete `RadioStrip` + radio styles; event chip; coolant marker |
| `src/ui/store/gameStore.ts` | React hooks | delete `useEventModal` |
| `src/ui/components/hud/TouchControls.tsx` | Touch buttons | contextual COOLANT |

Scratch harness (not in the repo): `$SCRATCH/events/` with `phaser-stub.ts`, a rolldown config aliasing `phaser` to it, and one `.ts` check per task. `$SCRATCH` = the session scratchpad directory.

---

### Task 1: Events carry one fixed outcome

**Files:**
- Modify: `src/types/event.ts`
- Modify: `public/data/events/flight_events.json`
- Modify: `src/services/FlightEventService.ts`
- Test: `$SCRATCH/events/check-events.ts`

**Interfaces:**
- Produces: `FlightEventDefinition.outcome: EventOutcome` where `interface EventOutcome { consequences: EventConsequence[]; caution: string; cautionSeconds: number }` (`cautionSeconds` 0 = rest of flight).
- Produces: `FlightEventService.applyOutcome(event: FlightEventDefinition, state: FlightState): FlightState` (pure on `state`: returns a new object, never mutates the argument).
- Produces: `FlightEventService.force(id: string): boolean` — DEV; emits `flight:event-triggered` for that id, ignoring trigger/odds/cooldown.
- Removes: `applyChoice`, `EventChoice`, `FlightAction`, consequence type `'action'`.

- [ ] **Step 1: Write the failing check**

`$SCRATCH/events/check-events.ts`:

```ts
import { FlightEventService } from 'E:/Data/Tu Ilmenau/Ashline-Air/src/services/FlightEventService';
import { EventBus } from 'E:/Data/Tu Ilmenau/Ashline-Air/src/game/utils/EventBus';
import events from 'E:/Data/Tu Ilmenau/Ashline-Air/public/data/events/flight_events.json';

let failed = 0;
const check = (ok: boolean, what: string): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed++; };

const defs = events as any[];
check(JSON.stringify(defs.map(d => d.id)) === '["bird_strike","fuel_leak"]', 'only bird_strike and fuel_leak remain');
check(defs.every(d => !('choices' in d) && d.outcome?.consequences?.length > 0 && d.outcome.caution), 'every event has an outcome and no choices');

FlightEventService.initialise(defs);
const base = (): any => ({ integrity: 100, engineTemp: 0.5, fuel: 50, throttle: 0.8, elapsedSeconds: 100,
  modifiers: { fuelBurnMult: 1, dragMult: 1, liftMult: 1, stabilityMult: 1 } });

const s0 = base();
const bird = FlightEventService.applyOutcome(defs[0], s0);
check(bird.integrity === 90 && Math.abs(bird.engineTemp - 0.6) < 1e-9, 'bird strike: -10 hull, +0.1 temp');
check(s0.integrity === 100 && s0.engineTemp === 0.5, 'bird strike leaves the input state untouched');

const s1 = base();
const leak = FlightEventService.applyOutcome(defs[1], s1);
check(Math.abs(leak.modifiers.fuelBurnMult - 1.15) < 1e-9, 'fuel leak: burn x1.15');
check(s1.modifiers.fuelBurnMult === 1, 'fuel leak leaves the input modifiers untouched');

// Nothing stays pending: one fires, the gap blocks the next, and after the gap another fires.
const fired: string[] = [];
EventBus.on('flight:event-triggered', ({ event }) => fired.push(event.id));
const realRandom = Math.random; Math.random = () => 0;
FlightEventService.reset();
FlightEventService.checkEvents({ ...base(), elapsedSeconds: 100 });
FlightEventService.checkEvents({ ...base(), elapsedSeconds: 101 });
FlightEventService.checkEvents({ ...base(), elapsedSeconds: 500, fuel: 1 });
Math.random = realRandom;
check(fired.length === 2, `fires, holds the gap, fires again after it (got ${fired.length})`);

check(FlightEventService.force('fuel_leak') && fired[fired.length - 1] === 'fuel_leak', 'force() fires the named event');
check(!FlightEventService.force('nope'), 'force() refuses an unknown id');

if (failed) { console.log(`${failed} FAILED`); process.exit(1); } else console.log('ALL PASS');
```

`$SCRATCH/events/phaser-stub.ts`:

```ts
const M = { Clamp: (v: number, a: number, b: number) => Math.min(b, Math.max(a, v)), Linear: (a: number, b: number, t: number) => a + (b - a) * t };
export default { Math: M };
```

`$SCRATCH/events/rolldown.config.mjs` (replace `<SCRATCH>` with the absolute Windows path, forward slashes):

```js
export default ['check-events', 'check-coolant'].map(name => ({
  input: `${name}.ts`, output: { file: `${name}.mjs`, format: 'esm' },
  resolve: { alias: { phaser: '<SCRATCH>/events/phaser-stub.ts' } },
}));
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$SCRATCH/events" && "E:/Data/Tu Ilmenau/Ashline-Air/node_modules/.bin/rolldown" -c rolldown.config.mjs && node check-events.mjs`
Expected: bundle error or FAIL lines — `applyOutcome`/`force` do not exist and the JSON still has four events with `choices`. (If `check-coolant.ts` does not exist yet, temporarily limit the config array to `['check-events']`.)

- [ ] **Step 3: Replace the event types**

In `src/types/event.ts`, replace `choices: EventChoice[];` in `FlightEventDefinition` with `outcome: EventOutcome;`, delete `EventChoice`, delete the `| 'action'` member (and its comment) from `ConsequenceType`, delete `FlightAction` entirely, and add:

```ts
/**
 * What an event does. One fixed result, no menu: the events used to stop the
 * flight and ask, and almost every answer was "lose some hull". Now the thing
 * just happens, and a caution chip says what it cost.
 */
export interface EventOutcome {
  consequences: EventConsequence[];
  /** The caution chip's text. */
  caution: string;
  /** How long the chip stays up, seconds. 0 = for the rest of the flight. */
  cautionSeconds: number;
}
```

- [ ] **Step 4: Rewrite the event data**

`public/data/events/flight_events.json` becomes:

```json
[
  {
    "id": "bird_strike",
    "title": "Bird Strike",
    "description": "A flock of large birds appears from nowhere. A dull thud shakes the cockpit.",
    "trigger": "random",
    "probability": 0.01,
    "cooldownSeconds": 300,
    "tags": ["random", "damage"],
    "outcome": {
      "caution": "BIRD STRIKE −10%",
      "cautionSeconds": 5,
      "consequences": [
        { "type": "delta", "target": "integrity", "value": -10, "description": "Leading edge caved in" },
        { "type": "delta", "target": "engineTemp", "value": 0.1, "description": "Debris through the engine" }
      ]
    }
  },
  {
    "id": "fuel_leak",
    "title": "Fuel Leak",
    "description": "The fuel gauge is dropping faster than expected. A thin mist is trailing from the wing.",
    "trigger": "on_fuel_low",
    "triggerThreshold": 0.4,
    "probability": 0.03,
    "cooldownSeconds": 999,
    "tags": ["fuel", "critical"],
    "outcome": {
      "caution": "FUEL LEAK",
      "cautionSeconds": 0,
      "consequences": [
        { "type": "multiply", "target": "fuelBurnRate", "value": 1.15, "description": "Fuel burning 15% faster" }
      ]
    }
  }
]
```

- [ ] **Step 5: Rework `FlightEventService`**

In `src/services/FlightEventService.ts`:

1. Import line: drop `FlightAction` → `import type { FlightEventDefinition, FlightState, EventConsequence, AircraftDefinition } from '../types';`
2. Delete the `pendingChoice` field, its reset in `reset()`, and both `if (this.pendingChoice) return null;` guards in `checkEvents` / `checkWeatherEvents`.
3. In `tryFire`, delete `this.pendingChoice = def;` and replace the trailing comment with:
   ```ts
   // FlightScene listens for this, plays the event's cinematic (bird flock,
   // fuel mist, …) and then applies its outcome. Nothing waits on the player.
   ```
4. Replace the whole `applyChoice` method with:
   ```ts
   /**
    * What the event does to the aeroplane. The state passed in is not touched;
    * the scene swaps in what comes back.
    */
   applyOutcome(event: FlightEventDefinition, state: FlightState): FlightState {
     let next: FlightState = { ...state, modifiers: { ...state.modifiers } };
     for (const c of event.outcome.consequences) next = this.applyConsequence(next, c);
     return next;
   }

   /** DEV: fire one event now, whatever its trigger, odds and cooldown. */
   force(id: string): boolean {
     const def = this.definitions.find(d => d.id === id);
     if (!def) return false;
     EventBus.emit('flight:event-triggered', { event: def });
     return true;
   }
   ```
5. In `applyConsequence`, delete the `if (c.type === 'action') { … }` block.

- [ ] **Step 6: Run the check to verify it passes**

Run: `cd "$SCRATCH/events" && "E:/Data/Tu Ilmenau/Ashline-Air/node_modules/.bin/rolldown" -c rolldown.config.mjs && node check-events.mjs`
Expected: `ALL PASS`. (`tsc` will still fail at this point — FlightScene and the HUD reference the deleted API; Task 2 fixes them.)

---

### Task 2: The flight stops pausing; outcomes land with a caution chip

**Files:**
- Modify: `src/game/utils/EventBus.ts`
- Modify: `src/game/scenes/FlightScene.ts`
- Modify: `src/ui/store/gameStore.ts`
- Modify: `src/ui/components/hud/FlightHUD.tsx`
- Modify: `src/ui/components/hud/hudStyles.ts`

**Interfaces:**
- Consumes: `FlightEventService.applyOutcome`, `EventOutcome` (Task 1).
- Produces: `flight:status` payload fields `eventCaution: string | null` and `coolantLeft: number` (Task 3 fills `coolantLeft`; this task emits a fixed `1`).
- Removes: bus events `ui:show-event-modal`, `ui:close-event-modal`, `flight:apply-event-choice`, `flight:event-choice`, `flight:event-action`; hook `useEventModal`; `hudStyles` 4th parameter `radioChoices`.

- [ ] **Step 1: Bus types**

In `src/game/utils/EventBus.ts`: drop `FlightAction` from the types import; delete the four lines `'flight:event-choice'`, `'flight:apply-event-choice'`, `'flight:event-action'` (with any comment directly above them), `'ui:show-event-modal'`, `'ui:close-event-modal'`. In `'flight:status'`, after `climbReserve: number;` add:

```ts
    /** The last flight event's caution — BIRD STRIKE, FUEL LEAK — while it stands. */
    eventCaution: string | null;
    /** Emergency coolant charges left this flight (C / COOLANT). */
    coolantLeft: number;
```

- [ ] **Step 2: Store and HUD lose the popup**

- `gameStore.ts`: delete `useEventModal` (and `FlightEventDefinition` from its imports if now unused).
- `hudStyles.ts`: change the signature to `hudStyles(uiScale: number, compact: boolean, touch = false, /** … */ lessonOnTop = false)`; in `cautions.top` delete the whole `+ (radioChoices > 0 ? … : 0)` term and the comment block that explains it (keep `+ (lessonOnTop ? n(84) : 0)`); delete the `// ── The radio call` section: `radioStrip`, `radioHead`, `radioLive`, `radioFrom`, `radioBody`, `radioChoices`, `radioChip`, `radioChipKey`, `radioChipText`, `radioChipCost`, and any `@keyframes`/type entries that only they use.
- `FlightHUD.tsx`: drop `useEventModal` from the import and `const event = useEventModal();`; call `hudStyles(vp.uiScale, compact, vp.isTouch, compact && !!(tutorial?.training || tutorial?.coach))`; change `{status?.dropZone && !(compact && event) && (` to `{status?.dropZone && (` and delete the comment line above it about the radio call; delete `{event && <RadioStrip … />}` with its comment, the `EventLike` interface and the whole `RadioStrip` function (with its doc comment); drop `EventBus` from imports if unused. In the cautions block, after the `engineFailed` chip add:
  ```tsx
  {status.eventCaution && <Chip s={styles} tone="#ff8844" text={status.eventCaution} />}
  ```

- [ ] **Step 3: FlightScene loses the pause and the action runner**

In `src/game/scenes/FlightScene.ts`:
- Import: `import type { ApproachKind } from '../../types';` (drop `FlightAction`).
- Delete the field `private eventModalOpen = false;` and `this.eventModalOpen = false;` in `init()`.
- `update()`: `if (this.landed || this.eventModalOpen) return;` → `if (this.landed) return;`
- In the `eventUnsubs` array delete the `ui:show-event-modal`, `ui:close-event-modal`, `flight:apply-event-choice` and `flight:event-action` subscriptions, and change the comment above the array to:
  ```ts
  // ── Event wiring ──────────────────────────────────────────────────────
  // Nothing in here pauses the flight: events play out and apply themselves.
  ```
- Delete the `runEventAction` method and its doc comment, and `cinematicOverheat` with its doc comment and its `case 'engine_overheating'` line in `playEventCinematic`.

- [ ] **Step 4: Apply outcomes and hold the caution**

Add a field next to `weatherCaution`:

```ts
  /** The last flight event's chip and when it comes down (Infinity = stays). */
  private eventCaution: { text: string; until: number } | null = null;
```

and `this.eventCaution = null;` in `init()` next to `this.weatherCaution = null;`.

Replace the `flight:event-triggered` subscription with:

```ts
      // An event plays its cinematic, then simply happens — no question, no
      // pause. Its chip says what it cost.
      EventBus.on('flight:event-triggered', ({ event }) => {
        this.disengageWarp(event.title.toLowerCase());
        this.playEventCinematic(event, () => {
          // The flight can end while the birds are still in the air
          if (this.landed || this.crashing) return;
          this.state = FlightEventService.applyOutcome(event, this.state);
          const { caution, cautionSeconds } = event.outcome;
          this.eventCaution = {
            text: caution,
            until: cautionSeconds > 0 ? this.state.elapsedSeconds + cautionSeconds : Infinity,
          };
        });
      }),
```

In the `flight:status` emit inside `updateHazards`, after `climbReserve: this.controller.climbReserve,` add:

```ts
      eventCaution: this.eventCaution && this.state.elapsedSeconds < this.eventCaution.until
        ? this.eventCaution.text : null,
      coolantLeft: 1,
```

In the crash-time `flight:status` emit in `finishFlight`, append `eventCaution: null, coolantLeft: 0,` after `climbReserve: 1,`.

- [ ] **Step 5: Type-check**

Run: `cd "e:/Data/Tu Ilmenau/Ashline-Air" && npx tsc --noEmit -p . ; echo "tsc exit: $?"`
Expected: `tsc exit: 0`. Any remaining reference to a deleted name (`applyChoice`, `useEventModal`, `radio*`, `FlightAction`, `eventModalOpen`) shows up here — remove it.

- [ ] **Step 6: Nothing left behind**

Run: `cd "e:/Data/Tu Ilmenau/Ashline-Air" && grep -rn "event-modal\|apply-event-choice\|event-choice\|event-action\|useEventModal\|eventModalOpen\|FlightAction\|RadioStrip\|radioStrip\|applyChoice\|engine_overheating\|distress_signal" src public ; echo "grep exit: $?"`
Expected: no matches, `grep exit: 1`.

---

### Task 3: Emergency coolant, one charge, the pilot's call

**Files:**
- Create: `src/game/entities/aircraft/Coolant.ts`
- Modify: `src/game/utils/controls.ts`, `src/game/utils/touchInput.ts`
- Modify: `src/game/audio/SoundEngine.ts`
- Modify: `src/game/scenes/FlightScene.ts`
- Modify: `src/ui/components/hud/FlightHUD.tsx`, `src/ui/components/hud/TouchControls.tsx`
- Test: `$SCRATCH/events/check-coolant.ts`

**Interfaces:**
- Produces: `export const COOLANT_HOT = 0.72;` and `export function tryDumpCoolant(state: FlightState, left: number): { state: FlightState; left: number; result: 'dumped' | 'not-hot' | 'empty' }` (never mutates `state`).
- Produces: `ControlAction` member `'coolant'` (`['C', 'COOLANT']`), `PulseControl` member `'coolant'`, `SoundEngine.steamVent(): void`.
- Consumes: `flight:status.coolantLeft` (Task 2).

- [ ] **Step 1: Write the failing check**

`$SCRATCH/events/check-coolant.ts`:

```ts
import { tryDumpCoolant, COOLANT_HOT } from 'E:/Data/Tu Ilmenau/Ashline-Air/src/game/entities/aircraft/Coolant';

let failed = 0;
const check = (ok: boolean, what: string): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed++; };
const st = (engineTemp: number, integrity = 100): any => ({ engineTemp, integrity, modifiers: {} });

const hot = st(0.95);
const a = tryDumpCoolant(hot, 1);
check(a.result === 'dumped' && a.left === 0, 'hot engine, charge aboard: dumped, charge spent');
check(Math.abs(a.state.engineTemp - 0.4) < 1e-9 && a.state.integrity === 98, 'temp to 40%, -2 hull');
check(hot.engineTemp === 0.95 && hot.integrity === 100, 'input state untouched');

const b = tryDumpCoolant(a.state, a.left);
check(b.result === 'empty' && b.left === 0 && b.state === a.state, 'second press: empty, nothing changes');

const cool = tryDumpCoolant(st(0.6), 1);
check(cool.result === 'not-hot' && cool.left === 1 && cool.state.engineTemp === 0.6, 'cool engine: charge kept');

const edge = tryDumpCoolant(st(COOLANT_HOT), 1);
check(edge.result === 'not-hot', 'exactly at the threshold is not hot');

const wreck = tryDumpCoolant(st(0.99, 1), 1);
check(wreck.state.integrity === 0, 'hull never goes below 0');

if (failed) { console.log(`${failed} FAILED`); process.exit(1); } else console.log('ALL PASS');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$SCRATCH/events" && "E:/Data/Tu Ilmenau/Ashline-Air/node_modules/.bin/rolldown" -c rolldown.config.mjs && node check-coolant.mjs`
Expected: bundle error — `Coolant.ts` does not exist.

- [ ] **Step 3: Write `Coolant.ts`**

```ts
import type { FlightState } from '../../../types';
import { clamp } from '../../utils/math';

/**
 * The emergency coolant charge.
 *
 * It used to be one answer in a popup that stopped the flight to ask — the
 * one answer anybody ever wanted. Now it is the pilot's own call: one charge
 * a flight, fired whenever the engine is cooking, and it costs a little
 * plumbing every time.
 */

/** Engine temperature above which the charge does anything — and the ENG readout shows. */
export const COOLANT_HOT = 0.72;
const COOLED_TO = 0.4;
const HULL_COST = 2;

export function tryDumpCoolant(
  state: FlightState, left: number,
): { state: FlightState; left: number; result: 'dumped' | 'not-hot' | 'empty' } {
  if (left <= 0) return { state, left: 0, result: 'empty' };
  // Never wasted on a cool engine: it is the one charge you get
  if (state.engineTemp <= COOLANT_HOT) return { state, left, result: 'not-hot' };
  return {
    state: { ...state, engineTemp: COOLED_TO, integrity: clamp(state.integrity - HULL_COST, 0, 100) },
    left: left - 1,
    result: 'dumped',
  };
}
```

- [ ] **Step 4: Run the check to verify it passes**

Run: `cd "$SCRATCH/events" && "E:/Data/Tu Ilmenau/Ashline-Air/node_modules/.bin/rolldown" -c rolldown.config.mjs && node check-coolant.mjs`
Expected: `ALL PASS`.

- [ ] **Step 5: Control names, touch pulse, sound**

- `controls.ts`: add `'coolant'` to the `ControlAction` union and `coolant: ['C', 'COOLANT'],` to `NAMES`.
- `touchInput.ts`: add `'coolant'` to the `PulseControl` union.
- `SoundEngine.ts`, after `flapMove()`:
  ```ts
  /** Coolant venting: a valve thunk and a long hiss of steam off the cowl. */
  steamVent(): void {
    this.blip(140, 0.08, 0.08, 'square');
    this.noiseBurst(1.2, 4200, 0.16, 'highpass', 0.7, 2400);
  }
  ```

- [ ] **Step 6: Wire it into the scene**

In `FlightScene.ts`:
- Imports: `import { tryDumpCoolant, COOLANT_HOT } from '../entities/aircraft/Coolant';`
- Field near `restartHoldFor`: `/** Emergency coolant charges left — one a flight. See Coolant. */ private coolantLeft = 1;` and `this.coolantLeft = 1;` in `init()`.
- Keys map: add `C:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.C),`.
- In `update()`, after the airbrake block (before the `M` mute block):
  ```ts
  if (Phaser.Input.Keyboard.JustDown(this.keys.C) || TouchInput.consume('coolant')) this.dumpCoolant();
  ```
- New method next to `disengageWarp`:
  ```ts
  /** Fire the emergency coolant charge, if there is one and the engine needs it. */
  private dumpCoolant(): void {
    const r = tryDumpCoolant(this.state, this.coolantLeft);
    this.coolantLeft = r.left;
    if (r.result === 'empty') {
      EventBus.emit('ui:show-notification', { message: 'No coolant left this flight.', type: 'info' });
      return;
    }
    if (r.result === 'not-hot') {
      EventBus.emit('ui:show-notification', { message: 'Engine is not hot — coolant saved for when it is.', type: 'info' });
      return;
    }
    this.state = r.state;
    SoundEngine.steamVent();
    const eng = this.aircraft.enginePoint();
    const steam = this.add.particles(eng.x, eng.y, 'px_soft', {
      lifespan: { min: 500, max: 1200 },
      speedX: { min: -140, max: -40 },
      speedY: { min: -60, max: 10 },
      scale: { start: 0.35, end: 1.1 },
      alpha: { start: 0.65, end: 0 },
      tint: [0xe8f0f2, 0xcfd8dc],
      emitting: false,
    }).setDepth(7);
    steam.explode(18);
    this.time.delayedCall(1300, () => steam.destroy());
    EventBus.emit('ui:show-notification', { message: 'Coolant dumped — engine back to 40%.', type: 'success' });
  }
  ```
- The overheat warning (`nagHeat` block) message becomes:
  ```ts
  message: this.coolantLeft > 0
    ? `ENGINE HOT — ease the power, or ${press('coolant')} to dump coolant (once)`
    : 'ENGINE HOT — ease the power, or lower the nose so the air cools it',
  ```
- Both `flight:status` emits: `coolantLeft: 1,` → `coolantLeft: this.coolantLeft,` in `updateHazards` (the crash emit keeps `0`).
- Keyboard legend strings: insert `C: Coolant   ` before `SPACE: Drop` in both variants.

- [ ] **Step 7: HUD marker and contextual touch button**

`FlightHUD.tsx`: import `COOLANT_HOT` from `'../../../game/entities/aircraft/Coolant'`; replace `const warnTemp = state.engineTemp > 0.72;` with `const warnTemp = state.engineTemp > COOLANT_HOT;`; directly after the `{warnTemp && <Mini … label="ENG" … />}` line add:

```tsx
{/* The charge, beside the reading it fixes — only while it could be used */}
{warnTemp && status && (
  <Mini s={styles} label="COOL" value={status.coolantLeft > 0 ? (vp.isTouch ? 'READY' : 'C') : 'USED'}
    tone={status.coolantLeft > 0 ? '#88ccff' : '#5a5040'} />
)}
```

`TouchControls.tsx`: import `COOLANT_HOT` the same way and, directly after the `engineOut` START button, add:

```tsx
{/* A cooking engine with the charge still aboard — the one time it is worth a button */}
{!engineOut && state.engineTemp > COOLANT_HOT && (status?.coolantLeft ?? 0) > 0 && (
  <PulseButton label="❄ COOLANT" scale={s} control="coolant" wide />
)}
```

- [ ] **Step 8: Type-check and build**

Run: `cd "e:/Data/Tu Ilmenau/Ashline-Air" && npx tsc --noEmit -p . ; echo "tsc exit: $?" && npm run build 2>&1 | tail -3`
Expected: `tsc exit: 0`, build `✓ built`.

---

### Task 4: DEV event keys and the in-game check

**Files:**
- Modify: `src/game/scenes/FlightScene.ts` (DEV keydown handler)

- [ ] **Step 1: DEV keys**

In the `if (import.meta.env.DEV)` keydown handler, after the `'0'` line add:

```ts
        // 8 / 9 force the two flight events, which are otherwise rare rolls
        if (ev.key === '8') FlightEventService.force('fuel_leak');
        if (ev.key === '9') FlightEventService.force('bird_strike');
```

and extend the comment above the handler: `…without waiting them out; 8 and 9 force a fuel leak and a bird strike.`

- [ ] **Step 2: Re-run every check**

Run: `cd "$SCRATCH/events" && "E:/Data/Tu Ilmenau/Ashline-Air/node_modules/.bin/rolldown" -c rolldown.config.mjs && node check-events.mjs && node check-coolant.mjs; cd "e:/Data/Tu Ilmenau/Ashline-Air" && npx tsc --noEmit -p . ; echo "tsc exit: $?"`
Expected: `ALL PASS` twice, `tsc exit: 0`.

- [ ] **Step 3: In-game check (dev server, user)**

On a contract flight, airborne:
1. Press **9** → birds cross, shake, `BIRD STRIKE −10%` chip for ~5 s, hull −10, **flight never pauses**.
2. Press **8** → wing mist starts, `FUEL LEAK` chip stays, arrival-fuel bar drops.
3. Climb at full power until ENG appears (> 72%): `COOL C` marker in blue. Press **C** → hiss, steam off the cowl, ENG drops to 40%, marker turns `USED`. Press **C** again → "No coolant left this flight."
4. With a cool engine press **C** → "coolant saved" and the marker stays ready next time it is hot.
5. Land (or abort) and start a new flight → no `FUEL LEAK` chip, coolant ready again.
6. On touch: the `❄ COOLANT` button exists only while hot with the charge aboard.

- [ ] **Step 4: Line endings**

Run: `cd "e:/Data/Tu Ilmenau/Ashline-Air" && git ls-files --eol $(git diff --name-only) src/game/entities/aircraft/Coolant.ts`
Expected: every working copy `w/crlf`; convert any `w/lf` to CRLF.
