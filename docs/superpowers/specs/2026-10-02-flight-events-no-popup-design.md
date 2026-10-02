# Flight events without the popup — design

Sub-project 1 of the UI declutter (order agreed 2026-10-02: event popup →
notifications → first-time flying → board selection → map/screens look).

## Problem

Four random flight events open a radio strip at the top of the screen
(`RadioStrip`, FlightHUD) that pauses the flight until the player picks an
answer. Most answers only shave a stat; the one decision players value is
"dump emergency coolant". The popup interrupts flying for very little.

## Outcome

- No event ever pauses the flight or asks a question.
- Events that remain play their cinematic and apply one fixed outcome,
  announced by a caution chip.
- Dumping coolant becomes a control the pilot fires themselves.

## What the player sees

| Event | Trigger (unchanged) | Outcome | Caution |
|---|---|---|---|
| Bird strike | random, p 0.01, 300 s cooldown | −10 hull, +0.1 engine temp | chip `BIRD STRIKE −10%` for 5 s |
| Fuel leak | fuel ≤ 40%, p 0.03, once | fuel burn ×1.15 for the rest of the flight, wing mist | chip `FUEL LEAK` for the rest of the flight |
| Engine overheating | — | removed (replaced by coolant control) | — |
| Distress signal | — | removed (supply drops cover it) | — |

**Coolant.** `C` on a keyboard; a `COOLANT` button on touch that appears only
while the engine is hot (temp > 0.72, the same threshold that shows the ENG
readout) and the charge is unused. One charge per flight. Effect: engine temp
set to 0.40, −2 hull, a steam puff from the cowl, toast `Coolant dumped`.
The ENG readout carries a marker showing whether the charge is still aboard.
The overheat warning names the control.

## Constraint from the user

Too many buttons already. The coolant button is contextual (hot engine,
charge left) and never permanent; nothing else is added to the screen.

## Design

Keep `FlightEventService` and `flight_events.json`; replace each event's
`choices[]` with a single `outcome`.

- `types/event.ts` — `FlightEventDefinition.choices` → `outcome: { consequences: EventConsequence[]; caution: string; cautionSeconds: number }`
  (`cautionSeconds` 0 = for the rest of the flight). Delete `EventChoice`,
  the `action` consequence type and `FlightAction`.
- `flight_events.json` — bird_strike and fuel_leak with outcomes; the other
  two removed.
- `FlightEventService` — `tryFire` no longer holds a pending choice; it emits
  `flight:event-triggered`. New `applyOutcome(event, state)` applies the
  consequences and returns the next state. `applyChoice`, `pendingChoice`
  and the `action` branch are deleted.
- `FlightScene` — on `flight:event-triggered`: play the cinematic, then
  `applyOutcome`, then set the event caution. Delete `eventModalOpen` (and
  the physics pause), `runEventAction` and the modal listeners. Add the C key,
  `coolantLeft` (1 per flight) and `dumpCoolant()`. `flight:status` gains
  `coolantLeft: number` and `eventCaution: string | null`. The coolant rule
  itself is a pure function in `entities/aircraft/Coolant.ts` so it can be
  checked headlessly.
- `FlightHUD` / `hudStyles` / `gameStore` — delete `RadioStrip`, the radio
  styles, the `radioChoices` layout parameter and `useEventModal`. Event
  caution chip in the cautions row; coolant marker on the ENG readout.
- `EventBus` — drop `ui:show-event-modal`, `ui:close-event-modal`,
  `flight:apply-event-choice`, `flight:event-choice`, `flight:event-action`.
- `controls.ts` / `touchInput.ts` / `TouchControls` — `coolant` action
  (`C` / `COOLANT`), contextual button.
- DEV only: key `8` forces a fuel leak, `9` a bird strike.

## Verification

No test framework in the repo. Type-check and production build; a headless
script that fires each event through `FlightEventService` and checks the
outcome lands and nothing stays pending; in-game check with the DEV keys and a
hot engine for coolant.
