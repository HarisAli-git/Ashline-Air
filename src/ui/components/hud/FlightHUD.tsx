import React from 'react';
import { useFlightState, useEventModal, useGearFlaps, useCargo, useRouteInfo, useFlightStatus } from '../../store/gameStore';
import { EventBus } from '../../../game/utils/EventBus';
import { SaveService } from '../../../services/SaveService';
import { useViewport } from '../../viewport';
import { hudStyles, type HudStyles } from './hudStyles';

export function FlightHUD(): React.ReactElement | null {
  const vp = useViewport();
  const state = useFlightState();
  const event = useEventModal();
  const { gearDown, flapsDeployed } = useGearFlaps();
  const cargo = useCargo();
  const route = useRouteInfo();
  const status = useFlightStatus();

  if (!state) return null;

  // A phone gets a genuinely COMPACT panel, not the desktop one scaled down:
  // at 390 px tall the full instrument strip ate a fifth of the screen and
  // "115 km/h" wrapped onto two lines. Secondary gauges drop out instead.
  const compact = vp.isCompact;
  const styles = hudStyles(vp.uiScale, compact);

  const { def } = SaveService.getActiveAircraft();
  const throttlePct = Math.round(state.throttle * 100);
  const speedKmh = Math.round(state.speed * 3.6);
  const tempPct = Math.round(state.engineTemp * 100);
  const fuelFrac = state.fuel / def.stats.fuelCapacity;
  const integrityColor = state.integrity > 60 ? '#00ff88' : state.integrity > 30 ? '#ffd080' : '#ff4444';
  const tempColor = tempPct > 80 ? '#ff4444' : tempPct > 60 ? '#ffd080' : '#00ff88';
  const fuelColor = fuelFrac < 0.18 ? '#ff4444' : fuelFrac < 0.4 ? '#ffd080' : '#e8d5b7';

  const progress = route ? Math.min(1, state.distanceTravelled / route.routeKm) : 0;
  const remainingKm = route ? Math.max(0, route.routeKm - state.distanceTravelled) : null;

  return (
    <>
      {/* Route progress strip */}
      {route && (
        <div style={styles.routeStrip}>
          <span style={{ ...styles.routeDot, background: '#8a7a5a' }} />
          <div style={styles.routeTrack}>
            <div style={{ ...styles.routeFill, width: `${progress * 100}%` }} />
            <span style={{ ...styles.planeMarker, left: `calc(${(progress * 100).toFixed(1)}% - 8px)` }}>✈</span>
          </div>
          <span style={{ ...styles.routeDot, background: remainingKm !== null && remainingKm < 1.5 ? '#00ff88' : '#5a4a20' }} />
          <span style={styles.routeLabel}>
            {route.destinationName}
            <span style={{ color: remainingKm !== null && remainingKm < 1.5 ? '#00ff88' : '#8a7a5a' }}>
              {'  '}{remainingKm !== null ? (remainingKm <= 0.05 ? 'ARRIVED — LAND' : `${remainingKm.toFixed(1)} km`) : ''}
            </span>
          </span>
        </div>
      )}

      {/* Main instrument panel — bottom strip */}
      <div style={styles.panel}>
        {!compact && <AttitudeIndicator pitch={state.pitch} styles={styles} />}
        <Gauge s={styles} label="ALT" value={`${state.altitude.toFixed(0)} m`} />
        <Gauge s={styles} label="SPD" value={compact ? `${speedKmh}` : `${speedKmh} km/h`} />
        <Gauge s={styles} label="V/S" value={`${state.verticalSpeed.toFixed(1)}`} color={state.verticalSpeed < -4 ? '#ff4444' : undefined} />
        <Gauge s={styles} label="THR" value={`${throttlePct}%`} pct={state.throttle} barColor="#c9a44a" />
        <Gauge s={styles} label="FUEL" value={`${state.fuel.toFixed(0)} L`} color={fuelColor} pct={fuelFrac} barColor={fuelColor} />
        {!compact && (
          <Gauge s={styles} label="ENG" value={`${tempPct}%`} color={tempColor} pct={state.engineTemp} barColor={tempColor} />
        )}
        <Gauge s={styles} label="INT" value={`${state.integrity.toFixed(0)}%`} color={integrityColor} pct={state.integrity / 100} barColor={integrityColor} />
        {cargo && !compact && (
          <Gauge
            s={styles}
            label="CARGO"
            value={`${cargo.average.toFixed(0)}%`}
            color={cargo.average > 75 ? '#00ff88' : cargo.average > 45 ? '#ffd080' : '#ff4444'}
            pct={cargo.average / 100}
            barColor={cargo.average > 75 ? '#00ff88' : cargo.average > 45 ? '#ffd080' : '#ff4444'}
          />
        )}
        {remainingKm !== null && (
          <Gauge s={styles} label="DIST" value={`${remainingKm.toFixed(1)}`} color={remainingKm < 1.5 ? '#00ff88' : undefined} />
        )}
        <div style={styles.toggles}>
          <span style={{ color: gearDown ? '#00ff88' : '#888' }}>GEAR {gearDown ? '▼' : '▲'}</span>
          <span style={{ color: flapsDeployed ? '#ffd080' : '#888' }}>FLAP {flapsDeployed ? 'ON' : 'OFF'}</span>
        </div>
      </div>

      {/* Annunciator panel — the things that will kill you, in priority order */}
      {status && (status.engineFailed || status.stall || status.overspeed || status.underFire
        || status.obstacleAheadM !== null || status.trafficDeltaM !== null
        || status.weatherCaution !== null) && (
        <div style={styles.annunciators}>
          {status.engineFailed && <Caution styles={styles} label={compact ? 'ENGINE OUT' : 'ENGINE OUT — HOLD E'} tone="#ff4444" />}
          {status.stall && <Caution styles={styles} label="STALL" tone="#ff4444" />}
          {/* Weather is now something you have to fly around, so it gets a
              light of its own with the action spelled out. */}
          {status.weatherCaution && (
            <Caution
              styles={styles}
              label={status.weatherCaution}
              tone={status.avionicsOut || status.iceLoad > 0.6 ? '#ff4444' : '#88ccff'}
            />
          )}
          {status.overspeed && <Caution styles={styles} label="OVERSPEED — EASE OFF" tone="#ff4444" />}
          {/* Traffic reads like the real box: how far off they are vertically,
              and the single word that resolves it. */}
          {status.trafficDeltaM !== null && (
            <Caution
              styles={styles}
              label={`✈ TRAFFIC ${Math.abs(Math.round(status.trafficDeltaM))} m ${status.trafficDeltaM >= 0 ? '▲' : '▼'} — ${status.trafficAvoid === 1 ? 'CLIMB' : 'DESCEND'}`}
              tone="#ff4444"
            />
          )}
          {/* Name the weapon and the height that beats it — "CLIMB" alone
              doesn't tell you whether that means 80 m or 340 m. */}
          {status.underFire && (
            <Caution
              styles={styles}
              label={status.groundThreat
                ? `${status.groundThreat.label} — CLIMB ${Math.round(status.groundThreat.clearM)} m`
                : 'TAKING FIRE — CLIMB'}
              tone={status.groundThreat && status.groundThreat.clearM > 200 ? '#ff4444' : '#ff8844'}
            />
          )}
          {status.obstacleAheadM !== null && (
            <Caution styles={styles} label={`OBSTACLE ${Math.round(status.obstacleAheadM)} m`} tone="#ffd080" />
          )}
        </div>
      )}

      {/* Notifications are rendered by the always-mounted GlobalNotification */}

      {/* Flight event modal */}
      {event && (
        <div style={styles.modalBackdrop}>
          {/*
            The dialog is a RADIO CALL, so it is dressed as one. Everything in
            here — weather, a distress signal, a warning light — reaches the
            pilot down a channel, and a generic bordered panel said nothing
            about that. The header is a live channel strip; the choices are
            the switches you actually throw, each showing what it will cost.
          */}
          <div style={styles.modal}>
            <div style={styles.modalChannel}>
              <span style={styles.modalLive} />
              <span style={styles.modalChannelText}>CABIN INTERCOM · 121.5</span>
              <span style={styles.modalChannelRule} />
            </div>
            <h2 style={styles.modalTitle}>{event.title}</h2>
            <p style={styles.modalDesc}>{event.description}</p>
            <div style={styles.choices}>
              {event.choices.map((choice, i) => (
                <button
                  key={choice.id}
                  style={styles.choiceBtn}
                  onClick={() => EventBus.emit('flight:apply-event-choice', { choiceId: choice.id })}
                >
                  <span style={styles.choiceKey}>{i + 1}</span>
                  <span style={styles.choiceBody}>
                    <span style={styles.choiceLabel}>{choice.label}</span>
                    {/* What it costs, in the player's terms, before they commit */}
                    <span style={styles.choiceCost}>
                      {choice.consequences.map(c => c.description).filter(Boolean).join('  ·  ')}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Blinking caution light in the annunciator stack. */
function Caution({ label, tone, styles }: {
  label: string; tone: string; styles: HudStyles;
}): React.ReactElement {
  return (
    <div style={{ ...styles.caution, color: tone, borderColor: tone }}>
      {label}
    </div>
  );
}

/** Mini artificial horizon: the sky/ground card shifts with pitch. */
function AttitudeIndicator({ pitch, styles }: {
  pitch: number; styles: HudStyles;
}): React.ReactElement {
  const shift = Math.max(-30, Math.min(30, pitch)) * 0.55;
  return (
    <div style={styles.adi}>
      <div style={{ ...styles.adiCard, transform: `translateY(${shift}px)` }}>
        <div style={styles.adiSky} />
        <div style={styles.adiGround} />
        <div style={styles.adiHorizon} />
      </div>
      {/* Fixed aircraft reference */}
      <div style={styles.adiWingL} />
      <div style={styles.adiWingR} />
      <div style={styles.adiDot} />
    </div>
  );
}

function Gauge({
  s: styles, label, value, color = '#e8d5b7', pct, barColor,
}: {
  s: HudStyles; label: string; value: string; color?: string; pct?: number; barColor?: string;
}): React.ReactElement {
  return (
    <div style={styles.gauge}>
      <span style={styles.gaugeLabel}>{label}</span>
      <span style={{ ...styles.gaugeValue, color }}>{value}</span>
      {pct !== undefined && (
        <div style={styles.barBg}>
          <div style={{
            ...styles.barFill,
            width: `${Math.max(0, Math.min(1, pct)) * 100}%`,
            background: barColor ?? color,
          }} />
        </div>
      )}
    </div>
  );
}
