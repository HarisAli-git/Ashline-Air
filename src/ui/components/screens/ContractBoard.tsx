import React, { useState, useEffect } from 'react';
import { SaveService } from '../../../services/SaveService';
import { ContractService } from '../../../services/ContractService';
import { EventBus } from '../../../game/utils/EventBus';
import { SoundEngine } from '../../../game/audio/SoundEngine';
import type { Contract, GoodDefinition } from '../../../types';
import { canOperate } from '../../../services/AirfieldService';
import { routeBlock, routeKmBetween, describeBlock } from '../../../services/RouteService';
import { useViewport } from '../../viewport';

interface Props {
  settlementId: string;
  onContractAccepted: () => void;
}

const TYPE_BADGE: Record<string, { label: string; color: string }> = {
  passenger: { label: 'PASSENGERS', color: '#88ccff' },
  emergency: { label: 'EMERGENCY', color: '#ff4444' },
  secret:    { label: 'DISCREET', color: '#c088ff' },
};

export function ContractBoard({ settlementId, onContractAccepted }: Props): React.ReactElement {
  // Re-render when the board or the economy changes under us
  const [, setTick] = useState(0);
  useEffect(() => {
    const u1 = EventBus.on('contract:board-refreshed', () => setTick(t => t + 1));
    const u2 = EventBus.on('economy:tick', () => setTick(t => t + 1));
    return () => { u1(); u2(); };
  }, []);

  const save = SaveService.get();
  const now = save.world.gameTimestamp;
  const { def: activeAircraft } = SaveService.getActiveAircraft();
  const contracts = save.world.availableContracts.filter(
    c => c.originId === settlementId && c.status === 'available'
  );
  const vp = useViewport();
  const styles = boardStyles(vp.uiScale, vp.isCompact);
  const [selected, setSelected] = useState<Contract | null>(null);
  const [accepted, setAccepted] = useState<string | null>(save.player.activeContractId);

  function repFor(factionId: string): number {
    return save.player.reputation.find(r => r.factionId === factionId)?.points ?? 0;
  }

  /** Range and runway, in one place. Null if the aircraft can fly this. */
  function blockFor(c: Contract) {
    const o = window.gameData.settlements.find(x => x.id === c.originId);
    const d = window.gameData.settlements.find(x => x.id === c.destinationId);
    if (!o || !d) return null;
    return routeBlock(activeAircraft, o, d);
  }

  function payloadWeight(c: Contract): number {
    return c.payload.reduce((sum, p) => sum + p.totalWeightKg, 0);
  }

  function accept(contract: Contract): void {
    if (repFor(contract.factionId) < contract.reputationRequirement) {
      EventBus.emit('ui:show-notification', {
        message: `Need ${contract.reputationRequirement} reputation with this faction.`,
        type: 'warning',
      });
      return;
    }
    if (payloadWeight(contract) > activeAircraft.stats.cargoCapacity) {
      EventBus.emit('ui:show-notification', {
        message: `Too heavy for your ${activeAircraft.name} (${payloadWeight(contract)} kg > ${activeAircraft.stats.cargoCapacity} kg).`,
        type: 'warning',
      });
      return;
    }
    // Range and runway. Refused here rather than discovered halfway across.
    const block = blockFor(contract);
    if (block) {
      EventBus.emit('ui:show-notification', {
        message: `Your ${activeAircraft.name} cannot fly this — ${describeBlock(block)}.`,
        type: 'warning',
      });
      return;
    }
    // Can this aeroplane actually get INTO the destination? This is the gate
    // that makes the fleet mean something: a heavy freighter simply cannot use
    // a 430 m mountain shelf, however well it pays.
    const dest = window.gameData.settlements.find(x => x.id === contract.destinationId);
    if (dest) {
      const verdict = canOperate(activeAircraft, dest);
      if (!verdict.ok) {
        EventBus.emit('ui:show-notification', { message: verdict.reason, type: 'warning' });
        return;
      }
    }
    const updated = ContractService.acceptContract(contract);

    // Mutate save in place (stateful update; proper state management can replace this)
    const s = SaveService.get();
    const idx = s.world.availableContracts.findIndex(c => c.id === contract.id);
    if (idx !== -1) s.world.availableContracts[idx] = updated;
    s.player.activeContractId = contract.id;
    SaveService.save(s.player, s.world);

    SoundEngine.chime();
    setAccepted(contract.id);
    onContractAccepted();

    EventBus.emit('ui:show-notification', {
      message: `Contract accepted: ${contract.title}`,
      type: 'success',
    });
  }

  if (contracts.length === 0) {
    return (
      <div style={styles.empty}>
        No contracts available at this settlement. Come back later.
      </div>
    );
  }

  return (
    <div style={styles.board}>
      <h3 style={styles.heading}>CONTRACT BOARD</h3>
      <div style={styles.list}>
        {contracts.map(c => {
          const locked = repFor(c.factionId) < c.reputationRequirement;
          const tooHeavy = payloadWeight(c) > activeAircraft.stats.cargoCapacity;
          const minutesLeft = Math.max(0, c.expiresAt - now);
          const badge = TYPE_BADGE[c.type];
          return (
            <div
              key={c.id}
              style={{
                ...styles.card,
                opacity: locked ? 0.55 : 1,
                borderColor: c.id === accepted ? '#00ff88' : c.id === selected?.id ? '#ffd080' : '#3a2a10',
              }}
              onClick={() => setSelected(c)}
            >
              <div style={styles.cardTitle}>
                {badge && <span style={{ ...styles.badge, color: badge.color, borderColor: badge.color }}>{badge.label}</span>}
                {c.title}
              </div>
              <div style={styles.cardMeta}>
                <span>{c.description}</span>
              </div>
              <div style={styles.cardFoot}>
                <div style={styles.cardReward}>
                <span style={styles.pay}>₢ {c.reward.basePay.toLocaleString()}</span>
                {/*
                  * On a phone this row carries only what changes the decision:
                  * the money, the distance, and anything that would stop you
                  * taking it. Bonus, reputation and the expiry clock are all
                  * detail you can read in the panel after selecting it, and on
                  * a 390 px screen they wrapped the row onto three lines.
                  */}
                {c.reward.bonusPay > 0 && !vp.isCompact && (
                  <span style={styles.bonus}> +₢{c.reward.bonusPay.toLocaleString()} bonus</span>
                )}
                {!vp.isCompact && <span style={styles.rep}>  +{c.reward.reputationGain} rep</span>}
                {!vp.isCompact && <span style={styles.expiry}>  ⏱ {minutesLeft} min</span>}
                {tooHeavy && <span style={styles.tooHeavy}>  ⚠ {payloadWeight(c)} kg</span>}
                {(() => {
                  const o = window.gameData.settlements.find(x => x.id === c.originId);
                  const d = window.gameData.settlements.find(x => x.id === c.destinationId);
                  if (!o || !d) return null;
                  const km = Math.round(routeKmBetween(o, d));
                  const blk = routeBlock(activeAircraft, o, d);
                  const far = blk?.reason === 'range';
                  return (
                    <span style={far ? styles.tooHeavy : styles.field}>
                      {'  '}↔ {km} km{far ? ' — out of range' : ''}
                    </span>
                  );
                })()}
                {(() => {
                  const d = window.gameData.settlements.find(x => x.id === c.destinationId);
                  if (!d) return null;
                  const v = canOperate(activeAircraft, d);
                  if (v.ok && vp.isCompact) return null;   // only worth saying when it blocks you
                  return (
                    <span style={v.ok ? styles.field : styles.tooHeavy}>
                      {'  '}▭ {d.field.runwayM} m{v.ok ? '' : ` — need ${activeAircraft.stats.runwayM} m`}
                    </span>
                  );
                })()}
                </div>
                {locked ? (
                  <span style={styles.lockedTag}>🔒 LOCKED — need {c.reputationRequirement} rep</span>
                ) : c.id === accepted ? (
                  <span style={styles.acceptedTag}>✓ ACCEPTED</span>
                ) : (
                  <button style={styles.acceptBtn} onClick={e => { e.stopPropagation(); accept(c); }}>
                    ACCEPT
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The board scales with the display.
 *
 * Every measurement here used to be a hardcoded pixel — 16 px padding, 15 px
 * titles, 12 px gaps — so a 390 px-tall phone rendered exactly the same box a
 * 1440 px monitor did, and two contracts filled the screen. It now takes the
 * same uiScale the rest of the interface uses, and drops the parts that are
 * commentary rather than decision when there is no room for them.
 */
function boardStyles(uiScale: number, compact: boolean): Record<string, React.CSSProperties> {
  const sc = uiScale;
  const n = (v: number): number => Math.round(v * sc);
  return {
    board: { padding: n(compact ? 8 : 16), fontFamily: 'monospace', color: '#e8d5b7' },
    field: { color: '#8a7a5a' },
    heading: {
      fontSize: n(compact ? 12 : 18), color: '#ffd080',
      marginBottom: n(compact ? 6 : 12), letterSpacing: 3,
    },
    list: { display: 'flex', flexDirection: 'column', gap: n(compact ? 6 : 12) },
    card: {
      border: '1px solid',
      padding: compact ? `${n(6)}px ${n(9)}px` : `${n(12)}px ${n(16)}px`,
      background: 'rgba(20,16,8,0.9)',
      cursor: 'pointer',
      borderRadius: 3,
    },
    cardTitle: {
      fontSize: n(compact ? 11.5 : 15), color: '#e8d5b7',
      marginBottom: n(compact ? 1 : 4), fontWeight: 'bold',
      // One line on a phone: the title names the job, the meta explains it
      ...(compact ? { whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' } : {}),
    },
    cardMeta: {
      fontSize: n(compact ? 9.5 : 12), color: '#8a7a5a',
      marginBottom: n(compact ? 3 : 8), lineHeight: 1.25,
      // Clamped rather than dropped — the distance is in here
      ...(compact ? {
        display: '-webkit-box', WebkitLineClamp: 1,
        WebkitBoxOrient: 'vertical' as const, overflow: 'hidden',
      } : {}),
    },
    cardReward: { fontSize: n(compact ? 10.5 : 13), marginBottom: compact ? 0 : n(10), minWidth: 0 },
    /*
     * On a phone the ACCEPT button shares the line with the numbers instead of
     * claiming a 34 px row of its own. That row was the single biggest part of
     * a card, and dropping it is the difference between seeing two contracts
     * and seeing four.
     */
    cardFoot: compact
      ? { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: n(8) }
      : {},
    pay: { color: '#ffd080' },
    bonus: { color: '#00ff88' },
    rep: { color: '#88ccff' },
    acceptBtn: {
      background: 'transparent',
      border: '1px solid #ffd080',
      color: '#ffd080',
      fontFamily: 'monospace',
      fontSize: n(compact ? 11 : 13),
      // Never below the tap target, however tight the display gets
      minHeight: 34,
      padding: compact ? `${n(3)}px ${n(10)}px` : `${n(5)}px ${n(14)}px`,
      cursor: 'pointer',
      borderRadius: 2,
    },
    acceptedTag: { color: '#00ff88', fontSize: n(compact ? 11 : 13) },
    lockedTag: { color: '#8a7a5a', fontSize: n(compact ? 10 : 13) },
    badge: {
      border: '1px solid',
      borderRadius: 2,
      fontSize: n(compact ? 8.5 : 10),
      padding: `1px ${n(compact ? 4 : 6)}px`,
      marginRight: n(compact ? 5 : 8),
      letterSpacing: 1,
      verticalAlign: 'middle',
    },
    expiry: { color: '#8a7a5a', fontSize: n(compact ? 10 : 12) },
    tooHeavy: { color: '#ff8844', fontSize: n(compact ? 10 : 12) },
    empty: { color: '#6a5a3a', fontFamily: 'monospace', padding: n(24) },
  };
}
