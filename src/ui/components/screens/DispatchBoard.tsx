import React, { useState, useEffect } from 'react';
import { SaveService } from '../../../services/SaveService';
import { ContractService } from '../../../services/ContractService';
import { EventBus } from '../../../game/utils/EventBus';
import { SoundEngine } from '../../../game/audio/SoundEngine';
import type { Contract } from '../../../types';
import { routeBlock, routeKmBetween, describeBlock, fuelCheck } from '../../../services/RouteService';
import { useViewport } from '../../viewport';

/**
 * The dispatch board.
 *
 * This replaces a contract list that floated over the canvas while the "FLY"
 * control lived underneath it as a Phaser text object — so the panel covered
 * the only way to leave. The fix is structural rather than positional: the
 * commit action is now a SIBLING of the list inside one panel, and the list
 * scrolls in a `min-height: 0` flex child. The bar owns the bottom edge and
 * cannot be occluded by anything, at any screen size.
 *
 * The thing on a real freight desk that this is modelled on is a load sheet:
 * what is going, where, what it weighs, what it pays, and — the part the game
 * never showed — whether there is enough in the tank to get there.
 */

const TYPE_TAG: Record<string, { label: string; tone: string }> = {
  passenger: { label: 'people', tone: '#88ccff' },
  emergency: { label: 'urgent', tone: '#ff6a4a' },
  secret:    { label: 'no manifest', tone: '#c088ff' },
};

interface Props {
  settlementId: string;
  onContractAccepted: () => void;
}

export function DispatchBoard({ settlementId, onContractAccepted }: Props): React.ReactElement {
  const [, setTick] = useState(0);
  useEffect(() => {
    const u1 = EventBus.on('contract:board-refreshed', () => setTick(t => t + 1));
    const u2 = EventBus.on('economy:tick', () => setTick(t => t + 1));
    const u3 = EventBus.on('player:fleet-changed', () => setTick(t => t + 1));
    const u4 = EventBus.on('player:money-changed', () => setTick(t => t + 1));
    return () => { u1(); u2(); u3(); u4(); };
  }, []);

  const vp = useViewport();
  const s = styles(vp.uiScale, vp.isCompact);

  const save = SaveService.get();
  const { owned, def: aircraft } = SaveService.getActiveAircraft();
  const settlements = window.gameData.settlements;
  const here = settlements.find(x => x.id === settlementId);

  const offers = save.world.availableContracts.filter(
    c => c.originId === settlementId && c.status === 'available',
  );
  const [picked, setPicked] = useState<string | null>(save.player.activeContractId);
  const selected = offers.find(c => c.id === picked) ?? null;

  const repFor = (f: string): number =>
    save.player.reputation.find(r => r.factionId === f)?.points ?? 0;
  const massOf = (c: Contract): number =>
    c.payload.reduce((t, p) => t + p.totalWeightKg, 0);

  /** Everything standing between this offer and the runway, in order. */
  function blockerFor(c: Contract): string | null {
    if (repFor(c.factionId) < c.reputationRequirement) {
      return `needs ${c.reputationRequirement} standing`;
    }
    if (massOf(c) > aircraft.stats.cargoCapacity) {
      return `${massOf(c).toLocaleString()} kg won't fit`;
    }
    const dest = settlements.find(x => x.id === c.destinationId);
    if (here && dest) {
      const blk = routeBlock(aircraft, here, dest);
      if (blk) return describeBlock(blk);
    }
    return null;
  }

  const selectedKm = selected && here
    ? routeKmBetween(here, settlements.find(x => x.id === selected.destinationId)!)
    : 0;
  const fuel = fuelCheck(aircraft, owned.fuel, selectedKm);
  const blocker = selected ? blockerFor(selected) : null;
  const canGo = selected !== null && blocker === null && fuel.ok;

  function depart(): void {
    if (!selected) return;
    const b = blockerFor(selected);
    if (b) {
      EventBus.emit('ui:show-notification', { message: `Can't take this one — ${b}.`, type: 'warning' });
      return;
    }
    if (!fuel.ok) {
      EventBus.emit('ui:show-notification', {
        message: `${fuel.shortL} L short for this leg. Refuel under Services first.`,
        type: 'warning',
      });
      return;
    }
    if (save.player.activeContractId !== selected.id) {
      ContractService.acceptContract(selected);
      const sv = SaveService.get();
      sv.player.activeContractId = selected.id;
      SaveService.save(sv.player, sv.world);
      onContractAccepted();
    }
    SoundEngine.chime();
    EventBus.emit('scene:depart', { contractId: selected.id });
  }

  return (
    <div style={s.root}>
      {/* ── What you are working with ─────────────────────────────────── */}
      <div style={s.head}>
        <span style={s.place}>{here?.name ?? 'Unknown field'}</span>
        <span style={s.craft}>{aircraft.name}</span>
      </div>

      {/* ── The offers ────────────────────────────────────────────────── */}
      <div className="aa-scroll" style={s.list}>
        {offers.length === 0 && (
          <div style={s.empty}>Nothing on the board here. Fly a delivery in and check again.</div>
        )}
        {offers.map(c => {
          const dest = settlements.find(x => x.id === c.destinationId);
          const km = here && dest ? routeKmBetween(here, dest) : 0;
          const blk = blockerFor(c);
          const on = c.id === picked;
          const tag = TYPE_TAG[c.type];
          return (
            <button
              key={c.id}
              onClick={() => setPicked(c.id)}
              style={{
                ...s.row,
                ...(on ? s.rowOn : {}),
                opacity: blk ? 0.62 : 1,
              }}
            >
              <div style={s.rowTop}>
                <span style={s.cargo}>
                  {c.payload[0]?.quantity ?? 1}× {goodName(c)}
                  <span style={s.arrow}> → </span>
                  {dest?.name ?? '?'}
                </span>
                <span style={s.pay}>{c.reward.basePay.toLocaleString()}</span>
              </div>
              <div style={s.rowBot}>
                <span style={s.fig}>{massOf(c).toLocaleString()} kg</span>
                <span style={s.fig}>{Math.round(km)} km</span>
                {tag && <span style={{ ...s.fig, color: tag.tone }}>{tag.label}</span>}
                {blk && <span style={s.blocked}>{blk}</span>}
              </div>
            </button>
          );
        })}
      </div>

      {/*
        * ── Dispatch ──────────────────────────────────────────────────────
        *
        * Always on screen, never scrolls away, and carries the one number the
        * old screen never showed: whether the tank covers the leg. The notch
        * on the gauge is what this route needs — if the fill does not reach
        * it, you are not going anywhere.
        */}
      <div style={s.bar}>
        <div style={s.barInfo}>
          <div style={s.gaugeRow}>
            <span style={s.gaugeLabel}>fuel</span>
            <div style={s.gauge}>
              <div style={{
                ...s.gaugeFill,
                width: `${Math.min(100, (owned.fuel / aircraft.stats.fuelCapacity) * 100)}%`,
                background: selected ? (fuel.ok ? '#9fe8b0' : '#c25a2a') : '#8a7a5a',
              }} />
              {selected && (
                <div style={{
                  ...s.gaugeNeed,
                  left: `${Math.min(100, (fuel.neededL / aircraft.stats.fuelCapacity) * 100)}%`,
                }} />
              )}
            </div>
            <span style={s.gaugeRead}>
              {Math.floor(owned.fuel)}
              {selected ? ` / ${fuel.neededL} L needed` : ` / ${aircraft.stats.fuelCapacity} L`}
            </span>
          </div>
          <div style={s.verdict}>
            {!selected && 'Pick a job above.'}
            {selected && blocker && `Can't take this one — ${blocker}.`}
            {selected && !blocker && !fuel.ok && `${fuel.shortL} L short. Refuel under Services.`}
            {selected && canGo && `${Math.round(selectedKm)} km to ${
              settlements.find(x => x.id === selected.destinationId)?.name}.`}
          </div>
        </div>
        <button
          onClick={depart}
          disabled={!canGo}
          style={{ ...s.go, ...(canGo ? {} : s.goOff) }}
        >
          Depart
        </button>
      </div>
    </div>
  );
}

function goodName(c: Contract): string {
  const id = c.payload[0]?.goodId;
  // Passengers are not in the goods table — they are people, and a manifest
  // that reads "6x cargo" for six settlers is the game not knowing its own
  // content.
  if (id === 'passengers') return c.payload[0].quantity === 1 ? 'passenger' : 'passengers';
  const g = window.gameData.goods.find(x => x.id === id);
  return g?.name ?? 'cargo';
}

function styles(uiScale: number, compact: boolean): Record<string, React.CSSProperties> {
  const n = (v: number): number => Math.round(v * uiScale);
  const hair = '1px solid #2a2114';
  return {
    root: {
      display: 'flex', flexDirection: 'column',
      height: '100%', minHeight: 0,
      fontFamily: 'monospace', color: '#e8d5b7',
    },

    head: {
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      gap: n(10), padding: `${n(compact ? 5 : 9)}px ${n(compact ? 9 : 14)}px`,
      borderBottom: hair, flexShrink: 0,
    },
    place: { fontSize: n(compact ? 12 : 15), color: '#e8d5b7', letterSpacing: 1 },
    craft: { fontSize: n(compact ? 9.5 : 11), color: '#8a7a5a' },

    // The list is the only thing allowed to grow, so the bar below always fits
    list: { flex: 1, minHeight: 0, overflowY: 'auto' },

    row: {
      display: 'block', width: '100%', textAlign: 'left',
      background: 'transparent', border: 'none', borderBottom: hair,
      borderLeft: '2px solid transparent',
      padding: `${n(compact ? 5 : 8)}px ${n(compact ? 9 : 14)}px`,
      cursor: 'pointer', color: 'inherit', fontFamily: 'monospace',
      minHeight: 40,
    },
    rowOn: { background: 'rgba(255,208,128,0.07)', borderLeftColor: '#ffd080' },
    rowTop: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: n(8) },
    cargo: {
      fontSize: n(compact ? 11 : 13.5), color: '#e8d5b7',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    },
    arrow: { color: '#6a5a3a' },
    // Scale contrast does the hierarchy: the payout is the only big thing here
    pay: {
      fontSize: n(compact ? 14 : 19), color: '#ffd080',
      fontWeight: 'bold', letterSpacing: -0.5, flexShrink: 0,
      fontVariantNumeric: 'tabular-nums',
    },
    rowBot: {
      display: 'flex', gap: n(compact ? 9 : 14), marginTop: n(2),
      fontSize: n(compact ? 9 : 10.5), color: '#7a6a4a', flexWrap: 'wrap',
    },
    fig: { fontVariantNumeric: 'tabular-nums' },
    blocked: { color: '#c25a2a' },
    empty: { padding: n(20), color: '#6a5a3a', fontSize: n(compact ? 10.5 : 12.5), lineHeight: 1.5 },

    bar: {
      display: 'flex', alignItems: 'center', gap: n(10),
      padding: `${n(compact ? 6 : 10)}px ${n(compact ? 9 : 14)}px`,
      borderTop: '1px solid #3a2a10', background: 'rgba(22,18,11,0.96)',
      flexShrink: 0,
    },
    barInfo: { flex: 1, minWidth: 0 },
    gaugeRow: { display: 'flex', alignItems: 'center', gap: n(7) },
    gaugeLabel: { fontSize: n(compact ? 8.5 : 10), color: '#6a5a3a', flexShrink: 0 },
    gauge: {
      position: 'relative', flex: 1, minWidth: n(60),
      height: n(compact ? 6 : 8), background: '#0b0906',
      border: '1px solid #2a2114', borderRadius: 1, overflow: 'visible',
    },
    gaugeFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 1 },
    // The notch: what this leg costs, marked on the tank you actually have
    gaugeNeed: {
      position: 'absolute', top: -3, bottom: -3, width: 2,
      background: '#ffd080', marginLeft: -1,
    },
    gaugeRead: {
      fontSize: n(compact ? 8.5 : 10), color: '#8a7a5a', flexShrink: 0,
      fontVariantNumeric: 'tabular-nums',
    },
    verdict: {
      fontSize: n(compact ? 9.5 : 11.5), color: '#8a7a5a',
      marginTop: n(3), lineHeight: 1.3,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    },

    go: {
      flexShrink: 0,
      background: '#ffd080', border: 'none', borderRadius: 2,
      color: '#140f06', fontFamily: 'monospace', fontWeight: 'bold',
      fontSize: n(compact ? 12 : 15),
      padding: `${n(compact ? 8 : 11)}px ${n(compact ? 14 : 22)}px`,
      minHeight: 40, cursor: 'pointer', letterSpacing: 0.5,
    },
    goOff: {
      background: 'transparent', color: '#4a4030',
      border: '1px solid #2a2114', cursor: 'not-allowed',
    },
  };
}
