import React from 'react';
import { useFlightState, useEventModal, useGearFlaps, useCargo, useRouteInfo, useFlightStatus } from '../../store/gameStore';
import { EventBus } from '../../../game/utils/EventBus';
import { SaveService } from '../../../services/SaveService';
import { useViewport } from '../../viewport';
import { hudStyles, type HudStyles } from './hudStyles';

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
  const { gearDown, flapsDeployed } = useGearFlaps();
  const cargo = useCargo();
  const route = useRouteInfo();
  const status = useFlightStatus();

  if (!state) return null;

  const compact = vp.isCompact;
  const styles = hudStyles(vp.uiScale, compact, vp.isTouch, event ? event.choices.length : 0);

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
            <Chip s={styles} tone="#ff4a3a" text={compact ? 'ENGINE OUT' : 'ENGINE OUT — HOLD E'} />
          )}
          {status.stall && <Chip s={styles} tone="#ff4a3a" text="STALL" />}
          {status.weatherCaution && (
            <Chip s={styles} text={status.weatherCaution}
              tone={status.avionicsOut || status.iceLoad > 0.6 ? '#ff4a3a' : '#88ccff'} />
          )}
          {status.overspeed && <Chip s={styles} tone="#ff4a3a" text="OVERSPEED" />}
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
          {status.obstacleAheadM !== null && (
            <Chip s={styles} tone="#ffd080" text={`OBSTACLE ${Math.round(status.obstacleAheadM)}m`} />
          )}
        </div>
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
        {warnTemp && <Mini s={styles} label="ENG" value={`${tempPct}%`} tone="#ff8844" />}
        {warnHull && (
          <Mini s={styles} label="HULL" value={`${integrity.toFixed(0)}%`}
            tone={integrity < 40 ? '#ff4a3a' : '#ff8844'} />
        )}
        {warnCargo && cargo && (
          <Mini s={styles} label="CARGO" value={`${cargo.average.toFixed(0)}%`} tone="#ff8844" />
        )}

        <div style={styles.configRow}>
          <span style={{ color: gearDown ? '#9fe8b0' : '#5a5040' }}>GEAR</span>
          <span style={{ color: flapsDeployed ? '#ffd080' : '#5a5040' }}>FLAP</span>
        </div>
      </div>

      {/* ── The radio call ──────────────────────────────────────────────── */}
      {event && <RadioStrip s={styles} event={event} compact={compact} />}
    </>
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
function RadioStrip({ s, event, compact }: {
  s: HudStyles; event: EventLike; compact: boolean;
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
              <span style={s.radioChipKey}>{i + 1}</span>
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

/** A caution, as a chip on the glass. */
function Chip({ s, text, tone }: { s: HudStyles; text: string; tone: string }): React.ReactElement {
  return <div style={{ ...s.chip, color: tone, borderColor: tone }}>{text}</div>;
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
