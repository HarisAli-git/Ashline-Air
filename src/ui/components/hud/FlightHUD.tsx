import React from 'react';
import { useFlightState, useEventModal, useGearFlaps, useCargo, useRouteInfo, useFlightStatus, useTutorial } from '../../store/gameStore';
import { EventBus, type DropZoneStatus } from '../../../game/utils/EventBus';
import { press } from '../../../game/utils/controls';
import { SaveService } from '../../../services/SaveService';
import { useViewport } from '../../viewport';
import { hudStyles, type HudStyles } from './hudStyles';
import { TrainingPanel, TrainingDebrief } from './TrainingPanel';

/**
 * The instrument panel was a slab.
 *
 * A full-width opaque strip, plus a stacked annunciator, plus a route box,
 * plus a bottom-sheet dialog, left almost nothing of a 390 px-tall phone for
 * the aeroplane — the interface was overshadowing the game it reports on.
 *
 * This throws the panel away entirely. The world cannot afford a glass
 * cockpit; what a scavenger pilot has is a few marks on the windscreen and a
 * radio. So every readout sits DIRECTLY ON THE GLASS with no background at
 * all, held together by two corner clusters and one hairline. Legibility comes
 * from a hard text shadow, which is what a reflected HUD looks like anyway.
 *
 * Three rules keep it honest:
 *   1. Nothing spans the screen. Corners only; the centre stays clear.
 *   2. Secondary numbers appear ONLY when off-nominal. In a healthy cruise,
 *      engine temp, hull and cargo are simply not on screen.
 *   3. Scale contrast carries the hierarchy the boxes used to: big numerals
 *      against 8 px labels.
 */
export function FlightHUD(): React.ReactElement | null {
  const vp = useViewport();
  const state = useFlightState();
  const event = useEventModal();
  const tutorial = useTutorial();
  const { gearDown, flapsDeployed } = useGearFlaps();
  const cargo = useCargo();
  const route = useRouteInfo();
  const status = useFlightStatus();

  if (!state) return null;

  const compact = vp.isCompact;
  const styles = hudStyles(
    vp.uiScale, compact, vp.isTouch, event ? event.choices.length : 0,
    compact && !!(tutorial?.training || tutorial?.coach),
  );

  const { def } = SaveService.getActiveAircraft();
  const speedKmh = Math.round(state.speed * 3.6);
  const tempPct = Math.round(state.engineTemp * 100);
  const fuelFrac = state.fuel / def.stats.fuelCapacity;
  const integrity = state.integrity;

  const progress = route ? Math.min(1, state.distanceTravelled / route.routeKm) : 0;
  const remainingKm = route ? Math.max(0, route.routeKm - state.distanceTravelled) : null;
  const arriving = remainingKm !== null && remainingKm < 1.5;

  // ── Progressive disclosure ────────────────────────────────────────────
  // These earn screen space only once they are a problem. Everything that is
  // fine stays invisible, which is most of what the old panel was showing.
  const warnTemp = state.engineTemp > 0.72;
  const warnFuel = fuelFrac < 0.28;
  const warnHull = integrity < 70;
  const warnCargo = cargo !== null && cargo.average < 80;

  return (
    <>
      {/* ── Route: a hairline along the very top edge, not a box ────────── */}
      {route && (
        <div style={styles.routeRail}>
          <div style={{ ...styles.routeRailFill, width: `${progress * 100}%` }} />
          <div style={{ ...styles.routeRailPip, left: `${progress * 100}%` }} />
          {arriving && (
            <span style={styles.routeRailLabel}>
              {remainingKm !== null && remainingKm <= 0.05
                ? 'ARRIVED — LAND'
                : `${route.destinationName}  ${remainingKm?.toFixed(1)} km`}
            </span>
          )}
        </div>
      )}

      {/* ── Cautions: chips, and only while they are true ───────────────── */}
      {status && (
        <div style={styles.cautions}>
          {status.engineFailed && (
            <Chip s={styles} tone="#ff4a3a" text={compact ? 'ENGINE OUT' : `ENGINE OUT — ${press('engine').toUpperCase()}`} />
          )}
          {status.stall && <Chip s={styles} tone="#ff4a3a" text="STALL" />}
          {status.weatherCaution && (
            <Chip s={styles} text={status.weatherCaution}
              tone={status.avionicsOut || status.iceLoad > 0.6 ? '#ff4a3a' : '#88ccff'} />
          )}
          {status.overspeed && <Chip s={styles} tone="#ff4a3a" text="OVERSPEED" />}
          {status.flaps?.overspeed && (
            <Chip s={styles} tone="#ff4a3a" text={`FLAP SPEED — BELOW ${status.flaps.limitKmh ?? ''}`} />
          )}
          {status.trafficDeltaM !== null && (
            <Chip s={styles} tone="#ff4a3a"
              text={`TRAFFIC ${Math.abs(Math.round(status.trafficDeltaM))}m ${status.trafficDeltaM >= 0 ? '▲' : '▼'} — ${status.trafficAvoid === 1 ? 'CLIMB' : 'DESCEND'}`} />
          )}
          {status.weatherAhead && (
            <Chip s={styles} tone={status.weatherAhead.kind === 'thunderstorm' ? '#ff8844' : '#88ccff'}
              text={`${WEATHER_LABEL[status.weatherAhead.kind] ?? 'WEATHER'} ${status.weatherAhead.km.toFixed(1)}km`} />
          )}
          {status.underFire && (
            <Chip s={styles} tone={status.groundThreat && status.groundThreat.clearM > 200 ? '#ff4a3a' : '#ff8844'}
              text={status.groundThreat
                ? `${status.groundThreat.label} — CLIMB ${Math.round(status.groundThreat.clearM)}m`
                : 'TAKING FIRE'} />
          )}
          {status.underFire && status.rangedOn > 0.45 && (
            <Chip s={styles} tone={status.rangedOn > 0.75 ? '#ff4a3a' : '#ff8844'}
              text={status.rangedOn > 0.75 ? 'THEY HAVE YOUR NUMBER — JINK' : 'GUNNERS RANGING YOU'} />
          )}
          {status.overshot && (
            <Chip s={styles} tone="#ffd080" text={`OVERSHOT — ${press('turn').toUpperCase()} TO TURN BACK`} />
          )}
          {status.obstacleAheadM !== null && (
            <Chip s={styles} tone="#ffd080"
              text={`${status.obstacleLabel ?? 'OBSTACLE'} ${Math.round(status.obstacleAheadM)}m — CLIMB`} />
          )}
        </div>
      )}

      {/* ── The next drop site, while somebody is calling ────────────────── */}
      {/* On a phone a radio call spans the top, so the card steps aside for it */}
      {status?.dropZone && !(compact && event) && (
        <DropCard s={styles} zone={status.dropZone} compact={compact} touch={vp.isTouch} />
      )}

      {/* ── Left cluster: the two numbers you actually fly by ───────────── */}
      <div style={styles.primary}>
        {/*
          The vario ribbon, and the signature of the whole HUD: a bar that
          grows UP from a centre line in lift and DOWN in sink, so the air the
          aeroplane is flying through is readable in peripheral vision. No
          numbers — the point is that it is read without looking at it.
        */}
        {status && <VarioRibbon s={styles} air={status.airVertical} inThermal={status.inThermal} />}
        <div style={styles.primaryStack}>
          <div style={styles.bigRow}>
            <span style={styles.bigNum}>{speedKmh}</span>
            <span style={styles.unit}>km/h</span>
          </div>
          {/*
            * The stall speed for the flaps you have out, in the air you are in.
            * Shown when it is close enough to matter — near the ground, with
            * flap out, or slowing toward it — because that is the number an
            * approach is flown against, and it MOVES with every notch of flap.
            */}
          {status && status.stallKmh > 0 && (state.altitude < 60 || state.flapsDeployed || speedKmh < status.stallKmh * 1.6) && (
            <div style={{
              ...styles.vs,
              color: speedKmh < status.stallKmh * 1.15 ? '#ff6a4a'
                : speedKmh < status.stallKmh * 1.3 ? '#ffd080' : '#8a7a5a',
            }}>
              STALL {status.stallKmh}
            </div>
          )}
          <div style={styles.bigRow}>
            <span style={{ ...styles.bigNum, ...styles.bigNumAlt }}>{state.altitude.toFixed(0)}</span>
            <span style={styles.unit}>m</span>
          </div>
          <div style={{
            ...styles.vs,
            color: state.verticalSpeed < -4 ? '#ff8844'
              : state.verticalSpeed > 0.5 ? '#9fe8b0' : '#8a7a5a',
          }}>
            {state.verticalSpeed >= 0 ? '▲' : '▼'} {Math.abs(state.verticalSpeed).toFixed(1)}
          </div>
        </div>
      </div>

      {/* ── Right cluster: what the aircraft has left ───────────────────── */}
      <div style={styles.rightCluster}>
        <Bar s={styles} label="THR" frac={state.throttle} tone="#ffd080"
          text={`${Math.round(state.throttle * 100)}`} />
        <Bar s={styles} label="FUEL" frac={fuelFrac} tone={warnFuel ? '#ff4a3a' : '#c8b888'}
          text={`${state.fuel.toFixed(0)}`} alert={warnFuel} />
        {/*
          * What you will land with, not what you have.
          *
          * This is the readout the cruise is built around: it answers "am I
          * winning right now?" every second, and throttle, height, wind and
          * whether you are in lift or sink all move it. Without something like
          * it, level flight has no feedback at all and there is nothing to do
          * between the climb-out and the approach.
          *
          * Hidden on the ground: a projection built from the burn you are
          * achieving reads 0% while you are parked with the engine off, which
          * is true and completely useless — an alarming red bar before you
          * have even started.
          */}
        {status && state.altitude > 2 && (
          <Bar s={styles} label="ARR" frac={status.fuelAtArrival}
            tone={status.fuelAtArrival < 0.08 ? '#ff4a3a'
              : status.fuelAtArrival < 0.2 ? '#ff8844' : '#9fe8b0'}
            text={`${Math.round(status.fuelAtArrival * 100)}`}
            alert={status.fuelAtArrival < 0.08} />
        )}

        {/* Only when they matter — see the note at the top of this file */}
        {/* Crates aboard — only while there is someone to drop them on */}
        {status?.dropReady && (
          <Mini s={styles} label="CRATES" value={`${status.cratesLeft}`} tone="#9fe8b0" />
        )}
        {warnTemp && <Mini s={styles} label="ENG" value={`${tempPct}%`} tone="#ff8844" />}
        {warnHull && (
          <Mini s={styles} label="HULL" value={`${integrity.toFixed(0)}%`}
            tone={integrity < 40 ? '#ff4a3a' : '#ff8844'} />
        )}
        {warnCargo && cargo && (
          <Mini s={styles} label="CARGO" value={`${cargo.average.toFixed(0)}%`} tone="#ff8844" />
        )}

        <div style={styles.configRow}>
          {/* Two of the four aircraft are on fixed legs — no chip for a
              control they do not have. */}
          {status?.retractableGear !== false && (
            <span style={{ color: gearDown ? '#9fe8b0' : '#5a5040' }}>GEAR</span>
          )}
        </div>
        <FlapGauge scale={vp.uiScale} compact={compact} stage={state.flapStage ?? (flapsDeployed ? 2 : 0)}
          angle={state.flapAngle ?? 0} stops={status?.flaps?.stops ?? [0, 10, 20, 35]}
          limitKmh={status?.flaps?.limitKmh ?? null} nextLimitKmh={status?.flaps?.nextLimitKmh ?? null}
          overspeed={!!status?.flaps?.overspeed} blownBack={!!status?.flaps?.blownBack} speedKmh={speedKmh} touch={vp.isTouch} />
      </div>

      {/* ── The radio call ──────────────────────────────────────────────── */}
      {event && <RadioStrip s={styles} event={event} compact={compact} touch={vp.isTouch} />}
      {/*
        * One line of teaching at the bottom centre — the only part of the
        * screen the HUD redesign left completely clear, and the same place
        * the keyboard legend sits (FlightScene hides that while this shows,
        * so they can never overlap).
        */}
      {tutorial && (tutorial.training || tutorial.coach
        ? <TrainingPanel lesson={tutorial} scale={vp.uiScale} compact={compact} touch={vp.isTouch} />
        : <div style={styles.tutorial}>{tutorial.text}</div>)}
      <TrainingDebrief scale={vp.uiScale} compact={compact} />
    </>
  );
}

/**
 * Where the next drop is, and what to do about it RIGHT NOW.
 *
 * The question the old drop never answered was "when do I bring it down?" —
 * the flare went up five seconds out and that was all the warning you got.
 * This card answers it in one line that changes as you fly: hold, start
 * down, you are in the band, drop now, too low. The green band drawn across
 * the sky is the same window, so the card and the world always agree.
 */
function DropCard({ s, zone, compact, touch }: {
  s: HudStyles; zone: DropZoneStatus; compact: boolean; touch: boolean;
}): React.ReactElement {
  const what = zone.kind === 'rooftop' ? 'rooftop' : zone.kind === 'square' ? 'square' : '';
  const place = `${zone.place}${what ? ` ${what}` : ''}`;
  const band = `${zone.lo}–${zone.hi} m`;
  const cue: Record<DropZoneStatus['cue'], { text: string; tone: string; pulse?: boolean }> = {
    hold: {
      // Outside the corridor the guns can still reach you low — say so. From
      // the far side they may cover the whole approach.
      text: zone.covered
        ? 'HOLD HEIGHT · guns cover this side — come in from the other way'
        : `HOLD HEIGHT · safe to descend in ${Math.max(0.1, zone.descendInKm).toFixed(1)} km`,
      tone: zone.covered ? '#ff8844' : '#c8b888',
    },
    descend: {
      text: `▼ DESCEND to ${band}${zone.descentRate > 0.5 ? ` · ~${Math.round(zone.descentRate)} m/s` : ''}`,
      tone: '#ffd080', pulse: true,
    },
    window: { text: `IN THE BAND · wait for the pin`, tone: '#9fe8b0' },
    release: { text: touch ? 'PIN ON THEM · DROP NOW' : 'PIN ON THEM · SPACE', tone: '#b8ffc8', pulse: true },
    low: { text: `▲ TOO LOW · climb to ${zone.lo} m`, tone: '#ff8844', pulse: true },
    late: { text: 'PAST THEM · release earlier next time', tone: '#8a7a5a' },
    behind: { text: `BEHIND YOU · ${press('turn').toUpperCase()} to go back`, tone: '#ffd080', pulse: true },
  };
  const c = cue[zone.cue];
  return (
    <div style={s.dropCard}>
      <div style={s.dropHead}>
        <span>📦 {compact ? place : `Drop · ${place}`}</span>
        {zone.besieged && <span style={s.dropBadge}>UNDER FIRE</span>}
      </div>
      <div style={s.dropRow}>
        <span style={s.dropKm}>
          {zone.km < 1 ? `${Math.round(zone.km * 1000)} m` : `${zone.km.toFixed(1)} km`}
          {zone.cue === 'behind' ? ' ↺' : ''}
        </span>
        <span style={s.dropPips} aria-label={`${zone.got} of ${zone.need} crates`}>
          {Array.from({ length: zone.need }, (_, i) => (
            <span key={i} style={{
              ...s.dropPip,
              background: i < zone.got ? '#9fe8b0' : 'transparent',
              border: `1px solid ${i < zone.got ? '#9fe8b0' : '#ffd080'}`,
            }} />
          ))}
        </span>
        {/*
          * Said in words as well as boxes. The pips alone were the only place
          * the count appeared, and nobody read four tiny squares as "they
          * need two more crates".
          */}
        <span style={s.dropNeed}>
          {zone.got >= zone.need ? 'SUPPLIED'
            : `NEEDS ${zone.need - zone.got} CRATE${zone.need - zone.got > 1 ? 'S' : ''}`}
          <span style={s.dropAboard}>{compact ? ` · ${zone.aboard} left` : ` · ${zone.aboard} aboard`}</span>
        </span>
      </div>
      <div style={{
        ...s.dropCue, color: c.tone,
        animation: c.pulse ? 'aa-pulse 0.9s ease-in-out infinite' : 'none',
      }}>{c.text}</div>
      {zone.gapM !== null && <DropMeter s={s} zone={zone} />}
    </div>
  );
}

/**
 * The run-in, as a strip: the fixed line is where a crate would land if it
 * went now, and the marker is the people, sliding in from the right as you
 * close. Release when the marker is inside the green. It is readable from
 * several seconds out — which the world itself is not, because at cruise the
 * site crosses the whole screen in about a second.
 */
function DropMeter({ s, zone }: { s: HudStyles; zone: DropZoneStatus }): React.ReactElement {
  const BEHIND = 60, AHEAD = 420;          // metres shown either side of the aim point
  const span = BEHIND + AHEAD;
  const at = (m: number): number => Math.max(0, Math.min(100, ((m + BEHIND) / span) * 100));
  const gap = zone.gapM ?? 0;
  const inWindow = Math.abs(gap) <= zone.windowM;
  const passed = gap < -zone.windowM;
  const tone = inWindow ? '#b8ffc8' : passed ? '#6a5a3a' : '#ffd080';
  const secs = zone.releaseIn ?? 0;
  return (
    <div style={s.meterWrap}>
      <div style={s.meterTrack}>
        <div style={{
          ...s.meterWindow,
          left: `${at(-zone.windowM)}%`, width: `${at(zone.windowM) - at(-zone.windowM)}%`,
          opacity: inWindow ? 1 : 0.55,
        }} />
        <div style={{ ...s.meterAim, left: `${at(0)}%` }} />
        <div style={{
          ...s.meterMark, left: `${at(gap)}%`, background: tone, boxShadow: `0 0 6px ${tone}`,
        }} />
      </div>
      <span style={{ ...s.meterRead, color: tone }}>
        {inWindow ? 'NOW' : passed ? 'PAST' : secs > 9.5 ? '···' : `${secs.toFixed(1)}s`}
      </span>
    </div>
  );
}

/** Plain names for what is standing in the way. */
const WEATHER_LABEL: Record<string, string> = {
  thunderstorm: '⛈ STORM',
  dust_storm: '🌫 DUST',
  blizzard: '❄ BLIZZARD',
  fog: '🌫 FOG',
  strong_winds: '💨 ROUGH AIR',
  cloudy: '☁ CLOUD',
};

interface EventLike {
  title: string;
  description: string;
  choices: Array<{
    id: string;
    label: string;
    consequences?: Array<{ description?: string }>;
  }>;
}

/**
 * An incoming call, docked under the route rail.
 *
 * The old version was a centred box — on a phone, a sheet taking well over
 * half the screen to ask a one-line question. Events arrive over the RADIO, so
 * this is shaped like a transmission: who is calling, what they said, and the
 * replies as numbered chips on the row beneath. Roughly three lines instead of
 * half a screen, and the aeroplane you are deciding about stays visible while
 * you decide.
 *
 * The cost of each choice is kept — knowing what a switch does before you
 * throw it is what made these decisions real rather than a coin toss — but it
 * is demoted to one quiet line under the label, and dropped entirely on a
 * phone where the room is not there.
 */
function RadioStrip({ s, event, compact, touch }: {
  s: HudStyles; event: EventLike; compact: boolean; touch: boolean;
}): React.ReactElement {
  return (
    <div style={s.radioStrip}>
      <div style={s.radioHead}>
        <span style={s.radioLive} />
        <span style={s.radioFrom}>{event.title}</span>
      </div>
      <p style={s.radioBody}>{event.description}</p>
      <div style={s.radioChoices}>
        {event.choices.map((choice, i) => {
          const cost = (choice.consequences ?? [])
            .map(c => c.description).filter(Boolean).join(' · ');
          return (
            <button
              key={choice.id}
              style={s.radioChip}
              onClick={() => EventBus.emit('flight:apply-event-choice', { choiceId: choice.id })}
            >
              {/* A number key means nothing to a finger */}
              {!touch && <span style={s.radioChipKey}>{i + 1}</span>}
              <span style={s.radioChipText}>
                <span>{choice.label}</span>
                {cost && !compact && <span style={s.radioChipCost}>{cost}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Vertical air movement as a ribbon growing from a centre line. */
function VarioRibbon({ s, air, inThermal }: {
  s: HudStyles; air: number; inThermal: boolean;
}): React.ReactElement {
  const t = Math.max(-1, Math.min(1, air / 5));
  const tone = inThermal ? '#00ff88' : air > 0.3 ? '#9fe8b0' : air < -1.2 ? '#ff8844' : '#5a5040';
  return (
    <div style={s.varioRail} aria-label="air mass">
      <div style={s.varioZero} />
      <div style={{
        ...s.varioFill,
        background: tone,
        boxShadow: inThermal ? `0 0 8px ${tone}` : 'none',
        height: `${Math.abs(t) * 50}%`,
        top: air >= 0 ? `${50 - Math.abs(t) * 50}%` : '50%',
      }} />
    </div>
  );
}

/**
 * Where the flaps are, drawn as what they are: a section through the wing
 * with the flap hanging off its trailing edge at the real deflection.
 *
 * "FLAP" lit or unlit could not say which notch you were on, and a notch is
 * the whole decision — the first is lift for a short take-off, the last is an
 * air brake for the approach. The lever's notch is marked underneath; the
 * panel itself swings to it on its motor, so you can watch them travel. The
 * limit speed for what is out sits beside it, red when you are over it.
 */
function FlapGauge({ scale, compact, stage, angle, stops, limitKmh, nextLimitKmh, overspeed, blownBack, speedKmh, touch }: {
  scale: number; compact: boolean; stage: number; angle: number; stops: number[];
  limitKmh: number | null; nextLimitKmh: number | null; overspeed: boolean; blownBack: boolean; speedKmh: number; touch: boolean;
}): React.ReactElement {
  const n = (v: number): number => Math.round(v * scale);
  const target = stops[Math.max(0, Math.min(3, stage))] ?? 0;
  const moving = Math.abs(target - angle) > 0.5;
  const tone = overspeed ? '#ff4a3a' : angle > 0.5 ? '#ffd080' : '#8a7a5a';
  const labels = ['UP', '1', '2', 'FULL'];
  const w = n(compact ? 70 : 84);
  // Too fast for the next notch: say so before it is asked for
  const nextTooFast = nextLimitKmh !== null && speedKmh > nextLimitKmh;
  return (
    <div style={{ marginTop: n(4), fontFamily: 'monospace', textShadow: '0 1px 0 #000, 0 0 6px #000' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: n(6) }}>
        <svg width={w} height={Math.round(w * 0.42)} viewBox="0 0 100 42" style={{ overflow: 'visible', filter: 'drop-shadow(0 1px 1px #000)' }}>
          {/* The notches, as faint rays from the hinge */}
          {stops.map((d, i) => {
            const r = (d * Math.PI) / 180;
            const x0 = 66 + Math.cos(r) * 22, y0 = 16 + Math.sin(r) * 22;
            const x1 = 66 + Math.cos(r) * 31, y1 = 16 + Math.sin(r) * 31;
            return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1}
              stroke={i === stage ? tone : '#5a5040'} strokeWidth={i === stage ? 2 : 1.2} strokeLinecap="round" />;
          })}
          {/* The wing section */}
          <path d="M3 17 C 6 9, 24 6, 44 7.5 L 66 12.5 L 66 19.5 L 44 20.5 C 26 21.5, 8 22, 3 17 Z"
            fill="#c8b888" fillOpacity={0.85} stroke="#2a2416" strokeWidth={0.8} />
          {/* The flap, at its real deflection */}
          <g transform={`rotate(${angle} 66 16)`}>
            <path d="M66 12.5 L 90 15.4 L 90 16.6 L 66 19.5 Z" fill={tone}
              stroke="#2a2416" strokeWidth={0.8} />
          </g>
          <circle cx={66} cy={16} r={1.6} fill="#2a2416" />
        </svg>
        <div style={{ fontSize: n(compact ? 9 : 10), color: tone, lineHeight: 1.15, letterSpacing: 0.5 }}>
          <div style={{ fontWeight: 'bold' }}>
            {angle < 0.5 && !moving ? (blownBack ? 'WAITING' : 'FLAPS UP') : `${Math.round(angle)}°`}{moving && !blownBack ? ' ▸' : ''}
          </div>
          {limitKmh !== null && (
            <div style={{ fontSize: n(8), color: overspeed ? '#ff4a3a' : '#8a7a5a' }}>MAX {limitKmh}</div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: n(5), fontSize: n(compact ? 8 : 9), letterSpacing: 0.5, marginTop: n(1) }}>
        {labels.map((l, i) => (
          <span key={l} style={{
            color: i === stage ? tone : '#5a5040',
            fontWeight: i === stage ? 'bold' : 'normal',
            borderBottom: i === stage ? `1px solid ${tone}` : '1px solid transparent',
          }}>{l}</span>
        ))}
        {!touch && !compact && (
          <span style={{ color: '#5a5040', marginLeft: n(4) }}>F▼ V▲</span>
        )}
      </div>
      {blownBack && (
        <div style={{ fontSize: n(8), color: '#ffd080', marginTop: n(1) }}>
          held back — slow down
        </div>
      )}
      {!blownBack && nextTooFast && stage < 3 && angle > -1 && (
        <div style={{ fontSize: n(8), color: '#8a7a5a', marginTop: n(1) }}>
          {labels[stage + 1]} below {nextLimitKmh}
        </div>
      )}
    </div>
  );
}

/** A caution, as a chip on the glass. */
function Chip({ s, text, tone }: { s: HudStyles; text: string; tone: string }): React.ReactElement {
  // Three quick beats when it first appears — the caution is the alert now,
  // not a toast underneath it saying the same thing
  return <div style={{ ...s.chip, color: tone, borderColor: tone, animation: 'aa-chip 0.4s ease-in-out 3' }}>{text}</div>;
}

/** A thin quantity bar with its value beside it. */
function Bar({ s, label, frac, tone, text, alert }: {
  s: HudStyles; label: string; frac: number; tone: string; text: string; alert?: boolean;
}): React.ReactElement {
  return (
    <div style={s.barRow}>
      <span style={s.barLabel}>{label}</span>
      <div style={s.barTrack}>
        <div style={{
          ...s.barFill,
          width: `${Math.max(0, Math.min(1, frac)) * 100}%`,
          background: tone,
          boxShadow: alert ? `0 0 6px ${tone}` : 'none',
        }} />
      </div>
      <span style={{ ...s.barValue, color: tone }}>{text}</span>
    </div>
  );
}

/** A single off-nominal reading. On screen only because something is wrong. */
function Mini({ s, label, value, tone }: {
  s: HudStyles; label: string; value: string; tone: string;
}): React.ReactElement {
  return (
    <div style={s.miniRow}>
      <span style={s.barLabel}>{label}</span>
      <span style={{ ...s.barValue, color: tone }}>{value}</span>
    </div>
  );
}
