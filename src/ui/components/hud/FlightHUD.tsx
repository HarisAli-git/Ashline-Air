import React from 'react';
import { useFlightState, useNotification, useEventModal, useGearFlaps } from '../../store/gameStore';
import { EventBus } from '../../../game/utils/EventBus';

export function FlightHUD(): React.ReactElement | null {
  const state = useFlightState();
  const notification = useNotification();
  const event = useEventModal();
  const { gearDown, flapsDeployed } = useGearFlaps();

  if (!state) return null;

  const throttlePct = Math.round(state.throttle * 100);
  const speedKmh = Math.round(state.speed * 3.6);
  const tempPct = Math.round(state.engineTemp * 100);
  const integrityColor = state.integrity > 60 ? '#00ff88' : state.integrity > 30 ? '#ffd080' : '#ff4444';
  const tempColor = tempPct > 80 ? '#ff4444' : tempPct > 60 ? '#ffd080' : '#00ff88';

  return (
    <>
      {/* Main instrument panel — bottom strip */}
      <div style={styles.panel}>
        <Gauge label="ALT" value={`${state.altitude.toFixed(0)} m`} />
        <Gauge label="SPD" value={`${speedKmh} km/h`} />
        <Gauge label="V/S" value={`${state.verticalSpeed.toFixed(1)} m/s`} color={state.verticalSpeed < -4 ? '#ff4444' : undefined} />
        <Gauge label="THR" value={`${throttlePct}%`} />
        <Gauge label="FUEL" value={`${state.fuel.toFixed(1)} L`} color={state.fuel < 15 ? '#ff4444' : undefined} />
        <Gauge label="ENG" value={`${tempPct}%`} color={tempColor} />
        <Gauge label="INT" value={`${state.integrity.toFixed(0)}%`} color={integrityColor} />
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

function Gauge({ label, value, color = '#e8d5b7' }: { label: string; value: string; color?: string }): React.ReactElement {
  return (
    <div style={styles.gauge}>
      <span style={styles.gaugeLabel}>{label}</span>
      <span style={{ ...styles.gaugeValue, color }}>{value}</span>
    </div>
  );
}

function notifColor(type: string): string {
  return { info: '#88ccff', warning: '#ffd080', danger: '#ff4444', success: '#00ff88' }[type] ?? '#888';
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 24,
    padding: '8px 24px',
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
    top: 20,
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
