import React, { useState, useEffect } from 'react';
import { SaveService } from '../../../services/SaveService';
import { ContractService } from '../../../services/ContractService';
import { EventBus } from '../../../game/utils/EventBus';
import type { Contract, GoodDefinition } from '../../../types';

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
  const [selected, setSelected] = useState<Contract | null>(null);
  const [accepted, setAccepted] = useState<string | null>(save.player.activeContractId);

  function repFor(factionId: string): number {
    return save.player.reputation.find(r => r.factionId === factionId)?.points ?? 0;
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
    const updated = ContractService.acceptContract(contract);

    // Mutate save in place (stateful update; proper state management can replace this)
    const s = SaveService.get();
    const idx = s.world.availableContracts.findIndex(c => c.id === contract.id);
    if (idx !== -1) s.world.availableContracts[idx] = updated;
    s.player.activeContractId = contract.id;
    SaveService.save(s.player, s.world);

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
              <div style={styles.cardReward}>
                <span style={styles.pay}>₢ {c.reward.basePay.toLocaleString()}</span>
                {c.reward.bonusPay > 0 && (
                  <span style={styles.bonus}> +₢{c.reward.bonusPay.toLocaleString()} bonus</span>
                )}
                <span style={styles.rep}>  +{c.reward.reputationGain} rep</span>
                <span style={styles.expiry}>  ⏱ {minutesLeft} min</span>
                {tooHeavy && <span style={styles.tooHeavy}>  ⚠ {payloadWeight(c)} kg</span>}
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
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  board: { padding: 16, fontFamily: 'monospace', color: '#e8d5b7' },
  heading: { fontSize: 18, color: '#ffd080', marginBottom: 12, letterSpacing: 3 },
  list: { display: 'flex', flexDirection: 'column', gap: 12 },
  card: {
    border: '1px solid',
    padding: '12px 16px',
    background: 'rgba(20,16,8,0.9)',
    cursor: 'pointer',
    borderRadius: 3,
  },
  cardTitle: { fontSize: 15, color: '#e8d5b7', marginBottom: 4, fontWeight: 'bold' },
  cardMeta: { fontSize: 12, color: '#8a7a5a', marginBottom: 8 },
  cardReward: { fontSize: 13, marginBottom: 10 },
  pay: { color: '#ffd080' },
  bonus: { color: '#00ff88' },
  rep: { color: '#88ccff' },
  acceptBtn: {
    background: 'transparent',
    border: '1px solid #ffd080',
    color: '#ffd080',
    fontFamily: 'monospace',
    fontSize: 13,
    padding: '5px 14px',
    cursor: 'pointer',
    borderRadius: 2,
  },
  acceptedTag: { color: '#00ff88', fontSize: 13 },
  lockedTag: { color: '#8a7a5a', fontSize: 13 },
  badge: {
    border: '1px solid',
    borderRadius: 2,
    fontSize: 10,
    padding: '1px 6px',
    marginRight: 8,
    letterSpacing: 1,
    verticalAlign: 'middle',
  },
  expiry: { color: '#8a7a5a', fontSize: 12 },
  tooHeavy: { color: '#ff8844', fontSize: 12 },
  empty: { color: '#6a5a3a', fontFamily: 'monospace', padding: 24 },
};
