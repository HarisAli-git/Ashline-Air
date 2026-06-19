import React, { useState } from 'react';
import { SaveService } from '../../../services/SaveService';
import { EconomyService } from '../../../services/EconomyService';
import type { SettlementDefinition, SettlementState, GoodDefinition } from '../../../types';

interface Props {
  settlementId: string;
}

export function EconomyScreen({ settlementId }: Props): React.ReactElement {
  const save = SaveService.get();
  const settlement = window.gameData.settlements.find(s => s.id === settlementId)!;
  const state = save.world.settlements.find(s => s.definitionId === settlementId)!;

  const [aircraft] = useState(() => {
    const owned = save.player.ownedAircraft[parseInt(save.player.activeAircraftId)];
    const def = window.gameData.aircraft.find(a => a.id === owned.definitionId)!;
    return { owned, def };
  });

  const fuelNeeded = aircraft.def.stats.fuelCapacity - aircraft.owned.fuel;
  const fuelCost = EconomyService.fuelCost(state, fuelNeeded);
  const repairNeeded = 100 - aircraft.owned.integrity;
  const repairCost = EconomyService.repairCost(state, repairNeeded);

  function refuel(): void {
    if (save.player.money < fuelCost) {
      alert('Not enough money to refuel.');
      return;
    }
    save.player.money -= fuelCost;
    aircraft.owned.fuel = aircraft.def.stats.fuelCapacity;
    SaveService.save(save.player, save.world);
    window.location.reload(); // simple refresh for MVP; replace with state management
  }

  function repair(): void {
    if (repairNeeded === 0) return;
    if (save.player.money < repairCost) {
      alert('Not enough money to repair.');
      return;
    }
    save.player.money -= repairCost;
    aircraft.owned.integrity = 100;
    SaveService.save(save.player, save.world);
    window.location.reload();
  }

  const availableGoods: GoodDefinition[] = settlement.goods
    .map(g => window.gameData.goods.find(gd => gd.id === g.goodId))
    .filter((g): g is GoodDefinition => g !== undefined);

  return (
    <div style={styles.screen}>
      <h3 style={styles.heading}>SERVICES & MARKET</h3>

      {/* Aircraft services */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Aircraft: {aircraft.def.name}</div>
        <div style={styles.row}>
          <span>Fuel: {aircraft.owned.fuel.toFixed(1)} / {aircraft.def.stats.fuelCapacity} L</span>
          <button style={styles.btn} onClick={refuel} disabled={fuelNeeded === 0}>
            Refuel — ₢{fuelCost.toLocaleString()}
          </button>
        </div>
        <div style={styles.row}>
          <span>Integrity: {aircraft.owned.integrity.toFixed(0)}%</span>
          <button style={styles.btn} onClick={repair} disabled={repairNeeded === 0}>
            Repair — ₢{repairCost.toLocaleString()}
          </button>
        </div>
        <div style={styles.fuelPrice}>
          Fuel price: ₢{state.fuelPrice.toFixed(2)}/L
        </div>
      </div>

      {/* Market prices */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Market Prices</div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Good</th>
              <th style={styles.th}>Price</th>
              <th style={styles.th}>Supply</th>
              <th style={styles.th}>Demand</th>
            </tr>
          </thead>
          <tbody>
            {availableGoods.map(good => {
              const gs = state.goodStates[good.id];
              if (!gs) return null;
              return (
                <tr key={good.id}>
                  <td style={styles.td}>{good.name}</td>
                  <td style={{ ...styles.td, color: '#ffd080' }}>₢{gs.currentPrice}</td>
                  <td style={styles.td}>
                    <BarIndicator value={gs.supplyLevel} color="#88ccff" />
                  </td>
                  <td style={styles.td}>
                    <BarIndicator value={gs.demandLevel} color="#ff8844" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={styles.wallet}>
        Wallet: <span style={{ color: '#ffd080' }}>₢{save.player.money.toLocaleString()}</span>
      </div>
    </div>
  );
}

function BarIndicator({ value, color }: { value: number; color: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 60, height: 8, background: '#2a2010', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 10, color: '#8a7a5a' }}>{Math.round(value)}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  screen: { padding: 16, fontFamily: 'monospace', color: '#e8d5b7', maxHeight: '70vh', overflowY: 'auto' },
  heading: { fontSize: 16, color: '#ffd080', letterSpacing: 3, marginBottom: 16 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 13, color: '#8a7a5a', letterSpacing: 2, marginBottom: 10 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  btn: {
    background: 'transparent',
    border: '1px solid #5a4a20',
    color: '#e8d5b7',
    fontFamily: 'monospace',
    fontSize: 12,
    padding: '4px 12px',
    cursor: 'pointer',
    borderRadius: 2,
  },
  fuelPrice: { fontSize: 11, color: '#6a5a3a', marginTop: 4 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { color: '#6a5a3a', textAlign: 'left', paddingBottom: 6, fontWeight: 'normal', letterSpacing: 1 },
  td: { color: '#c8b888', paddingBottom: 8, paddingRight: 12 },
  wallet: { fontSize: 14, marginTop: 8 },
};
