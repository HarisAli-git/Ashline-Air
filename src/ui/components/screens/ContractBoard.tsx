import React, { useState, useEffect } from 'react';
import { SaveService } from '../../../services/SaveService';
import { ContractService } from '../../../services/ContractService';
import { EventBus } from '../../../game/utils/EventBus';
import type { Contract, GoodDefinition } from '../../../types';

interface Props {
  settlementId: string;
  onContractAccepted: () => void;
}

export function ContractBoard({ settlementId, onContractAccepted }: Props): React.ReactElement {
  const save = SaveService.get();
  const contracts = save.world.availableContracts.filter(
    c => c.originId === settlementId && c.status === 'available'
  );
  const [selected, setSelected] = useState<Contract | null>(null);
  const [accepted, setAccepted] = useState<string | null>(save.player.activeContractId);

  function accept(contract: Contract): void {
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
        {contracts.map(c => (
          <div
            key={c.id}
            style={{
              ...styles.card,
              borderColor: c.id === accepted ? '#00ff88' : c.id === selected?.id ? '#ffd080' : '#3a2a10',
            }}
            onClick={() => setSelected(c)}
          >
            <div style={styles.cardTitle}>{c.title}</div>
            <div style={styles.cardMeta}>
              <span>{c.description}</span>
            </div>
            <div style={styles.cardReward}>
              <span style={styles.pay}>₢ {c.reward.basePay.toLocaleString()}</span>
              {c.reward.bonusPay > 0 && (
                <span style={styles.bonus}> +₢{c.reward.bonusPay.toLocaleString()} bonus</span>
              )}
              <span style={styles.rep}>  +{c.reward.reputationGain} rep</span>
            </div>
            {c.id !== accepted && (
              <button style={styles.acceptBtn} onClick={e => { e.stopPropagation(); accept(c); }}>
                ACCEPT
              </button>
            )}
            {c.id === accepted && (
              <span style={styles.acceptedTag}>✓ ACCEPTED</span>
            )}
          </div>
        ))}
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
  empty: { color: '#6a5a3a', fontFamily: 'monospace', padding: 24 },
};
