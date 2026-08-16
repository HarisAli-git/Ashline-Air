import React, { useCallback, useEffect, useState } from 'react';
import { AircraftService, type AircraftAvailability } from '../../../services/AircraftService';
import { SaveService } from '../../../services/SaveService';
import { DevService } from '../../../services/DevService';
import { EventBus } from '../../../game/utils/EventBus';
import type { AircraftDefinition } from '../../../types';
import { useViewport } from '../../viewport';
import { panelChrome, tappable } from './panelChrome';

/**
 * The hangar: the screen that turns money into capability.
 *
 * Every airframe in the game is listed with what it can do and what it costs.
 * Anything you own can be selected; anything you can afford can be bought;
 * anything gated says exactly what it wants. The active aircraft is serviced
 * from here too, so fuel and repairs have a home.
 */

const TIER_LABEL: Record<number, string> = {
  1: 'LIGHT', 2: 'MEDIUM', 3: 'HEAVY',
};

export function HangarScreen(): React.ReactElement {
  const [, force] = useState(0);
  const refresh = useCallback(() => force(n => n + 1), []);

  useEffect(() => {
    const u1 = EventBus.on('player:fleet-changed', refresh);
    const u2 = EventBus.on('player:money-changed', refresh);
    return () => { u1(); u2(); };
  }, [refresh]);

  const vp = useViewport();
  const save = SaveService.get();
  const fleet = AircraftService.all();
  const activeIdx = AircraftService.activeIndex(save);
  const active = save.player.ownedAircraft[activeIdx];

  const buy = (def: AircraftDefinition): void => {
    const r = AircraftService.purchase(def.id);
    EventBus.emit('ui:show-notification', {
      message: r.message, type: r.ok ? 'success' : 'warning',
    });
    refresh();
  };

  const select = (definitionId: string): void => {
    const idx = save.player.ownedAircraft.findIndex(o => o.definitionId === definitionId);
    if (idx >= 0 && AircraftService.select(idx)) {
      const def = window.gameData.aircraft.find(a => a.id === definitionId);
      EventBus.emit('ui:show-notification', {
        message: `${def?.name ?? 'Aircraft'} is now your active aircraft.`, type: 'info',
      });
      refresh();
    }
  };

  const service = (): void => {
    const r = AircraftService.serviceActive();
    EventBus.emit('ui:show-notification', { message: r.message, type: r.ok ? 'success' : 'warning' });
    refresh();
  };

  const chrome = panelChrome(vp, 940, 560);

  return (
    <div style={{ ...styles.backdrop, ...chrome.backdrop, background: 'rgba(6,5,3,0.88)', zIndex: 40 }}>
      <div style={{ ...styles.panel, ...chrome.panel }}>
        <div style={styles.header}>
          <span style={styles.title}>HANGAR</span>
          <span style={styles.money}>₢ {save.player.money.toLocaleString()}</span>
          <button style={tappable(vp, styles.close)} onClick={() => EventBus.emit('ui:close-hangar')}>
            CLOSE
          </button>
        </div>

        {/* Active aircraft + servicing */}
        {active && (() => {
          const def = window.gameData.aircraft.find(a => a.id === active.definitionId);
          if (!def) return null;
          return (
            <div style={styles.activeBar}>
              <span style={{ color: '#ffd080' }}>FLYING: {def.name}</span>
              <span style={styles.cond}>⛽ {Math.round((active.fuel / def.stats.fuelCapacity) * 100)}%</span>
              <span style={styles.cond}>⚙ {Math.round(active.integrity)}%</span>
              <button style={tappable(vp, styles.serviceBtn)} onClick={service}>FUEL &amp; REPAIR</button>
              {DevService.enabled && (
                <button
                  style={{ ...styles.serviceBtn, borderColor: '#88ccff', color: '#88ccff' }}
                  onClick={() => {
                    EventBus.emit('ui:show-notification', {
                      message: DevService.unlockEverything(), type: 'success',
                    });
                    refresh();
                  }}
                >DEV: UNLOCK ALL</button>
              )}
            </div>
          );
        })()}

        <div className="aa-scroll" style={styles.list}>
          {fleet.map(def => {
            const av = AircraftService.availability(def, save);
            return <Row key={def.id} def={def} av={av} onBuy={() => buy(def)} onSelect={() => select(def.id)} />;
          })}
        </div>
      </div>
    </div>
  );
}

function Row({ def, av, onBuy, onSelect }: {
  def: AircraftDefinition;
  av: AircraftAvailability;
  onBuy: () => void;
  onSelect: () => void;
}): React.ReactElement {
  const locked = av.state === 'locked';
  const s = def.stats;
  return (
    <div style={{
      ...styles.row,
      opacity: locked ? 0.5 : 1,
      borderColor: av.state === 'owned' && av.active ? '#ffd080' : '#3a2f1a',
    }}>
      <div style={styles.rowMain}>
        <div>
          <span style={styles.name}>{def.name}</span>
          <span style={styles.tier}>{TIER_LABEL[def.tier] ?? `T${def.tier}`}</span>
          {av.state === 'owned' && av.active && <span style={styles.badge}>ACTIVE</span>}
        </div>
        <div style={styles.desc}>{def.description}</div>
        <div style={styles.stats}>
          <Stat label="CARGO" value={`${s.cargoCapacity} kg`} />
          <Stat label="CRUISE" value={`${s.cruiseSpeed} km/h`} />
          <Stat label="RANGE" value={`${Math.round(s.fuelCapacity / s.fuelBurnRate * 60)} min`} />
          <Stat label="STALL" value={`${s.stallSpeed} km/h`} />
          <Stat label="RELIABILITY" value={`${Math.round(s.engineReliability * 100)}%`} />
          <Stat label="HANDLING" value={`${11 - s.landingDifficulty}/10`} />
        </div>
      </div>

      <div style={styles.rowAction}>
        {av.state === 'owned' && !av.active && (
          <button style={styles.primaryBtn} onClick={onSelect}>FLY THIS</button>
        )}
        {av.state === 'owned' && av.active && <span style={styles.ownedText}>IN SERVICE</span>}
        {av.state === 'buyable' && (
          <button style={styles.primaryBtn} onClick={onBuy}>
            BUY ₢{av.cost.toLocaleString()}
          </button>
        )}
        {av.state === 'too-poor' && (
          <>
            <span style={styles.costText}>₢{av.cost.toLocaleString()}</span>
            <span style={styles.shortText}>short ₢{av.short.toLocaleString()}</span>
          </>
        )}
        {av.state === 'locked' && <span style={styles.lockText}>{av.reason}</span>}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <span style={styles.stat}>
      <span style={styles.statLabel}>{label}</span>
      <span style={styles.statValue}>{value}</span>
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'absolute', inset: 0, background: 'rgba(6,5,3,0.88)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'monospace', zIndex: 40,
  },
  // Size comes from panelChrome() so it can never exceed the viewport.
  panel: {},
  header: {
    display: 'flex', alignItems: 'center', gap: 16, padding: '10px 16px',
    borderBottom: '1px solid #3a2f1a', background: '#0a0804', flexShrink: 0,
  },
  title: { color: '#ffd080', fontSize: 16, fontWeight: 'bold', letterSpacing: 4, flex: 1 },
  money: { color: '#ffd080', fontSize: 16 },
  close: {
    background: 'transparent', border: '1px solid #5a4a20', color: '#c8b888',
    padding: '8px 14px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12,
  },
  activeBar: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '8px 16px',
    borderBottom: '1px solid #241c10', fontSize: 12, color: '#c8b888', flexShrink: 0,
  },
  cond: { color: '#8a7a5a' },
  serviceBtn: {
    background: 'transparent', border: '1px solid #5a4a20', color: '#e8d5b7',
    padding: '3px 10px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
  },
  list: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 },
  row: {
    display: 'flex', flexWrap: 'wrap', gap: 12, padding: '10px 12px', marginBottom: 8,
    border: '1px solid #3a2f1a', background: '#15110a', alignItems: 'center',
  },
  rowMain: { flex: 1, minWidth: 0 },
  name: { color: '#e8d5b7', fontSize: 15, fontWeight: 'bold', marginRight: 8 },
  tier: {
    color: '#8a7a5a', fontSize: 10, border: '1px solid #3a2f1a',
    padding: '1px 5px', marginRight: 8, letterSpacing: 1,
  },
  badge: { color: '#ffd080', fontSize: 10, letterSpacing: 1 },
  desc: { color: '#6a5a3a', fontSize: 11, margin: '3px 0 6px' },
  stats: { display: 'flex', flexWrap: 'wrap', gap: 12 },
  stat: { display: 'flex', flexDirection: 'column' },
  statLabel: { color: '#4a4030', fontSize: 9, letterSpacing: 1 },
  statValue: { color: '#c8b888', fontSize: 12 },
  rowAction: {
    // Shrinks and wraps under the description on a narrow panel instead of
    // squeezing the aircraft name into a two-character column.
    width: 190, flex: '0 1 190px', minWidth: 120,
    display: 'flex', flexDirection: 'column',
    alignItems: 'flex-end', gap: 3, marginLeft: 'auto',
  },
  primaryBtn: {
    background: '#2a2010', border: '1px solid #8a6a2a', color: '#ffd080',
    padding: '6px 14px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12,
  },
  ownedText: { color: '#ffd080', fontSize: 12 },
  costText: { color: '#c8b888', fontSize: 13 },
  shortText: { color: '#ff8844', fontSize: 10 },
  lockText: { color: '#6a5a3a', fontSize: 10, textAlign: 'right' },
};
