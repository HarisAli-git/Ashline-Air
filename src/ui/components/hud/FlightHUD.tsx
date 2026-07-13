import React from 'react';
import { useFlightState, useNotification, useEventModal, useGearFlaps, useCargo, useRouteInfo } from '../../store/gameStore';
import { EventBus } from '../../../game/utils/EventBus';
import { SaveService } from '../../../services/SaveService';

export function FlightHUD(): React.ReactElement | null {
  const state = useFlightState();
  const notification = useNotification();
  const event = useEventModal();
  const { gearDown, flapsDeployed } = useGearFlaps();
  const cargo = useCargo();
  const route = useRouteInfo();

  if (!state) return null;

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
        <Gauge label="ALT" value={`${state.altitude.toFixed(0)} m`} />
        <Gauge label="SPD" value={`${speedKmh} km/h`} />
        <Gauge label="V/S" value={`${state.verticalSpeed.toFixed(1)} m/s`} color={state.verticalSpeed < -4 ? '#ff4444' : undefined} />
        <Gauge label="THR" value={`${throttlePct}%`} pct={state.throttle} barColor="#c9a44a" />
        <Gauge label="FUEL" value={`${state.fuel.toFixed(0)} L`} color={fuelColor} pct={fuelFrac} barColor={fuelColor} />
        <Gauge label="ENG" value={`${tempPct}%`} color={tempColor} pct={state.engineTemp} barColor={tempColor} />
        <Gauge label="INT" value={`${state.integrity.toFixed(0)}%`} color={integrityColor} pct={state.integrity / 100} barColor={integrityColor} />
        {cargo && (
          <Gauge
            label="CARGO"
            value={`${cargo.average.toFixed(0)}%`}
            color={cargo.average > 75 ? '#00ff88' : cargo.average > 45 ? '#ffd080' : '#ff4444'}
            pct={cargo.average / 100}
            barColor={cargo.average > 75 ? '#00ff88' : cargo.average > 45 ? '#ffd080' : '#ff4444'}
          />
        )}
        {remainingKm !== null && (
          <Gauge label="DIST" value={`${remainingKm.toFixed(1)} km`} color={remainingKm < 1.5 ? '#00ff88' : undefined} />
        )}
        <div style={styles.toggles}>
          <span style={{ color: gearDown ? '#00ff88' : '#888' }}>GEAR {gearDown ? '▼' : '▲'}</span>
          <span style={{ color: flapsDeployed ? '#ffd080' : '#888' }}>FLAPS {flapsDeployed ? 'ON' : 'OFF'}</span>
        </div>
      </div>

      {/* Notification toast */}
      {notification && (
        <div style={{ ...styles.notification, borderColor: notifColor(notification.type) }}>
          {notification.message}
        </div>
      )}

      {/* Flight event modal */}
      {event && (
        <div style={styles.modalBackdrop}>
          <div style={styles.modal}>
            <h2 style={styles.modalTitle}>{event.title}</h2>
            <p style={styles.modalDesc}>{event.description}</p>
            <div style={styles.choices}>
              {event.choices.map(choice => (
                <button
                  key={choice.id}
                  style={styles.choiceBtn}
                  onClick={() => EventBus.emit('flight:apply-event-choice', { choiceId: choice.id })}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Gauge({
  label, value, color = '#e8d5b7', pct, barColor,
}: {
  label: string; value: string; color?: string; pct?: number; barColor?: string;
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

function notifColor(type: string): string {
  return { info: '#88ccff', warning: '#ffd080', danger: '#ff4444', success: '#00ff88' }[type] ?? '#888';
}

const styles: Record<string, React.CSSProperties> = {
  routeStrip: {
    position: 'fixed',
    top: 8,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: 520,
    padding: '6px 14px',
    background: 'rgba(10,8,4,0.75)',
    border: '1px solid #3a2a10',
    borderRadius: 4,
    fontFamily: 'monospace',
    zIndex: 90,
  },
  routeDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  routeTrack: {
    position: 'relative',
    flex: 1,
    height: 4,
    background: '#241a0c',
    borderRadius: 2,
  },
  routeFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: '100%',
    background: '#5a4a20',
    borderRadius: 2,
  },
  planeMarker: {
    position: 'absolute',
    top: -9,
    fontSize: 13,
    color: '#ffd080',
    transition: 'left 0.4s linear',
  },
  routeLabel: {
    fontSize: 11,
    color: '#c8b888',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  panel: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 22,
    padding: '8px 24px 10px',
    background: 'rgba(10,8,4,0.88)',
    borderTop: '1px solid #3a2a10',
    fontFamily: 'monospace',
    zIndex: 100,
  },
  gauge: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    minWidth: 64,
    gap: 2,
  },
  gaugeLabel: {
    fontSize: 10,
    color: '#6a5a3a',
    letterSpacing: 2,
  },
  gaugeValue: {
    fontSize: 16,
    color: '#e8d5b7',
    fontWeight: 'bold',
  },
  barBg: {
    width: 56,
    height: 3,
    background: '#241a0c',
    borderRadius: 2,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 2,
  },
  toggles: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 13,
    fontFamily: 'monospace',
    marginLeft: 'auto',
  },
  notification: {
    position: 'fixed',
    top: 48,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(10,8,4,0.92)',
    border: '1px solid',
    padding: '10px 24px',
    fontFamily: 'monospace',
    fontSize: 15,
    color: '#e8d5b7',
    zIndex: 200,
    borderRadius: 4,
  },
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.75)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 300,
  },
  modal: {
    background: '#1a1208',
    border: '1px solid #5a4a20',
    padding: '32px 40px',
    maxWidth: 520,
    width: '90%',
    fontFamily: 'monospace',
    borderRadius: 4,
  },
  modalTitle: {
    color: '#ffd080',
    fontSize: 22,
    marginBottom: 12,
  },
  modalDesc: {
    color: '#c8b888',
    fontSize: 15,
    lineHeight: 1.6,
    marginBottom: 24,
  },
  choices: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  choiceBtn: {
    background: 'transparent',
    border: '1px solid #5a4a20',
    color: '#e8d5b7',
    fontFamily: 'monospace',
    fontSize: 14,
    padding: '10px 16px',
    cursor: 'pointer',
    textAlign: 'left',
    borderRadius: 2,
  },
};
