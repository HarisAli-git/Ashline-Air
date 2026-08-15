import React, { useState } from 'react';
import { ProfileService, type Pilot } from '../../../services/ProfileService';
import { SaveService } from '../../../services/SaveService';
import { EventBus } from '../../../game/utils/EventBus';

/**
 * Pick a pilot. No account, no password — each pilot is a named save slot in
 * this browser, so several people can share a machine without overwriting each
 * other, and one person can keep a clean run beside an experimental one.
 */
export function ProfilesScreen(): React.ReactElement {
  const [pilots, setPilots] = useState<Pilot[]>(() => ProfileService.list());
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const activeId = ProfileService.activeId;

  const refresh = (): void => setPilots(ProfileService.list());

  const summaryOf = (p: Pilot): string => {
    try {
      const raw = localStorage.getItem(ProfileService.saveKeyFor(p.id));
      if (!raw) return 'new pilot';
      const s = JSON.parse(raw);
      const money = s?.player?.money ?? 0;
      const flights = s?.player?.stats?.totalFlights ?? 0;
      const fleet = s?.player?.ownedAircraft?.length ?? 1;
      return `₢${Number(money).toLocaleString()} · ${flights} flights · ${fleet} aircraft`;
    } catch {
      return 'new pilot';
    }
  };

  const choose = (id: string): void => {
    ProfileService.select(id);
    SaveService.invalidate();
    EventBus.emit('ui:close-profiles');
    // The whole game reads from the save on scene entry, so the cleanest way
    // to swap pilots is to re-enter from the top.
    window.location.reload();
  };

  const create = (): void => {
    const p = ProfileService.create(name || `Pilot ${pilots.length + 1}`);
    setName('');
    choose(p.id);
  };

  return (
    <div style={styles.backdrop}>
      <div style={styles.panel}>
        <div style={styles.header}>
          <span style={styles.title}>PILOTS</span>
          {activeId && (
            <button style={styles.close} onClick={() => EventBus.emit('ui:close-profiles')}>
              CLOSE
            </button>
          )}
        </div>

        <div style={styles.list}>
          {pilots.length === 0 && (
            <div style={styles.empty}>No pilots yet. Sign one on below.</div>
          )}
          {pilots.map(p => (
            <div key={p.id} style={{
              ...styles.row,
              borderColor: p.id === activeId ? '#ffd080' : '#3a2f1a',
            }}>
              <div style={{ flex: 1 }}>
                <div>
                  <span style={styles.name}>{p.name}</span>
                  {p.id === activeId && <span style={styles.badge}>SIGNED IN</span>}
                </div>
                <div style={styles.sub}>{summaryOf(p)}</div>
              </div>
              {confirmDelete === p.id ? (
                <>
                  <button
                    style={{ ...styles.btn, borderColor: '#a33', color: '#ff8877' }}
                    onClick={() => { ProfileService.remove(p.id); setConfirmDelete(null); refresh(); }}
                  >DELETE FOR GOOD</button>
                  <button style={styles.btn} onClick={() => setConfirmDelete(null)}>CANCEL</button>
                </>
              ) : (
                <>
                  {p.id !== activeId && (
                    <button style={styles.primary} onClick={() => choose(p.id)}>FLY AS</button>
                  )}
                  <button style={styles.btn} onClick={() => setConfirmDelete(p.id)}>DELETE</button>
                </>
              )}
            </div>
          ))}
        </div>

        <div style={styles.newRow}>
          <input
            style={styles.input}
            value={name}
            maxLength={20}
            placeholder="New pilot name"
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') create(); }}
          />
          <button style={styles.primary} onClick={create}>SIGN ON</button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'absolute', inset: 0, background: 'rgba(6,5,3,0.93)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'monospace', zIndex: 50,
  },
  panel: { width: 560, background: '#100d07', border: '1px solid #3a2f1a' },
  header: {
    display: 'flex', alignItems: 'center', padding: '10px 16px',
    borderBottom: '1px solid #3a2f1a', background: '#0a0804',
  },
  title: { color: '#ffd080', fontSize: 15, fontWeight: 'bold', letterSpacing: 4, flex: 1 },
  close: {
    background: 'transparent', border: '1px solid #5a4a20', color: '#c8b888',
    padding: '4px 12px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
  },
  list: { maxHeight: 320, overflowY: 'auto', padding: 10 },
  empty: { color: '#6a5a3a', fontSize: 12, padding: 16, textAlign: 'center' },
  row: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
    marginBottom: 7, border: '1px solid #3a2f1a', background: '#15110a',
  },
  name: { color: '#e8d5b7', fontSize: 14, marginRight: 8 },
  badge: { color: '#ffd080', fontSize: 9, letterSpacing: 1 },
  sub: { color: '#6a5a3a', fontSize: 11, marginTop: 2 },
  btn: {
    background: 'transparent', border: '1px solid #5a4a20', color: '#c8b888',
    padding: '5px 10px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
  },
  primary: {
    background: '#2a2010', border: '1px solid #8a6a2a', color: '#ffd080',
    padding: '5px 12px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
  },
  newRow: {
    display: 'flex', gap: 8, padding: '10px 14px', borderTop: '1px solid #241c10',
  },
  input: {
    flex: 1, background: '#0a0804', border: '1px solid #3a2f1a', color: '#e8d5b7',
    padding: '6px 10px', fontFamily: 'monospace', fontSize: 12, outline: 'none',
  },
};
