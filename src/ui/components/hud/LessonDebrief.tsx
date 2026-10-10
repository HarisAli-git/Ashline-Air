import React, { useEffect, useState } from 'react';
import { EventBus } from '../../../game/utils/EventBus';

/**
 * How the lesson went: the stars, what earned each one, the pay, and where
 * to go next. Over the aeroplane wherever it stopped. Enter takes the main
 * button, so the next lesson is one key away.
 */

const AMBER = '#ffd080';
const BONE = '#e8d5b7';
const ASH = '#8a7a5a';
const GREEN = '#9fe8b0';
const RED = '#ff8844';
const ETCH = '0 1px 0 rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.85)';

type Debrief = {
  id: string; n: number; title: string; passed: boolean; stars: number;
  criteria: Array<{ text: string; met: boolean }>;
  reason?: string; reward: number; takeaway?: string; nextId: string | null;
};
type Action = 'next' | 'retry' | 'school' | 'map';

export function LessonDebrief({ scale, compact }: { scale: number; compact: boolean }): React.ReactElement | null {
  const [d, setD] = useState<Debrief | null>(null);
  useEffect(() => {
    const u1 = EventBus.on('flight:lesson-complete', setD);
    // A fresh flight starts clean
    const u2 = EventBus.on('flight:route-info', () => setD(null));
    const u3 = EventBus.on('scene:return-to-map', () => setD(null));
    return () => { u1(); u2(); u3(); };
  }, []);

  const buttons: Array<{ label: string; action: Action }> = !d ? []
    : d.passed && d.nextId ? [
      { label: 'Next lesson ▸', action: 'next' }, { label: 'Fly it again', action: 'retry' }, { label: 'Flight school', action: 'school' },
    ]
      : d.passed ? [{ label: 'Flight school', action: 'school' }, { label: 'Fly it again', action: 'retry' }, { label: 'Map', action: 'map' }]
        : [{ label: 'Try again', action: 'retry' }, { label: 'Flight school', action: 'school' }];

  const primary = buttons[0]?.action;
  useEffect(() => {
    if (!primary) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') EventBus.emit('flight:lesson-exit', { action: primary });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [primary]);

  if (!d) return null;
  const n = (v: number): number => Math.round(v * scale);
  const tone = d.passed ? GREEN : RED;
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(6,4,2,0.4)', pointerEvents: 'auto', zIndex: 400, fontFamily: 'monospace',
    }}>
      <div style={{
        width: compact ? '72%' : 'min(480px, 60%)',
        background: 'linear-gradient(180deg, rgba(18,14,7,0.96) 0%, rgba(12,9,4,0.94) 100%)',
        borderTop: `3px solid ${tone}`, borderRadius: 4,
        padding: `${n(compact ? 12 : 18)}px ${n(compact ? 16 : 22)}px`,
        textShadow: ETCH, boxShadow: '0 10px 40px rgba(0,0,0,0.6)', animation: 'aa-step 0.35s ease-out',
      }}>
        <div style={{ fontSize: n(9.5), letterSpacing: 2.5, color: ASH }}>
          FLIGHT SCHOOL · LESSON {d.n} · {d.title.toUpperCase()}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: n(12), margin: `${n(4)}px 0 ${n(compact ? 8 : 12)}px` }}>
          <span style={{ fontSize: n(compact ? 17 : 22), fontWeight: 'bold', color: tone, letterSpacing: 1 }}>
            {d.passed ? 'Passed' : 'Not yet'}
          </span>
          <span aria-label={`${d.stars} of 3 stars`} style={{ fontSize: n(compact ? 20 : 26), letterSpacing: 4, whiteSpace: 'nowrap' }}>
            {[0, 1, 2].map(i => (
              <span key={i} style={{ color: i < d.stars ? AMBER : '#3a3222' }}>★</span>
            ))}
          </span>
        </div>
        {!d.passed && d.reason && (
          <div style={{ color: RED, fontSize: n(compact ? 11 : 13), marginBottom: n(8) }}>{d.reason}</div>
        )}
        <div style={{ fontSize: n(compact ? 10.5 : 12.5), lineHeight: 1.7 }}>
          {d.criteria.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: n(8), alignItems: 'baseline' }}>
              <span style={{ color: c.met ? AMBER : '#4a4030', width: n(14) }}>{c.met ? '★' : '☆'}</span>
              <span style={{ color: c.met ? BONE : ASH }}>{c.text}</span>
            </div>
          ))}
        </div>
        {d.reward > 0 && (
          <div style={{ marginTop: n(10), color: AMBER, fontSize: n(compact ? 11 : 13), fontWeight: 'bold' }}>
            +₢{d.reward.toLocaleString()} — first pass
          </div>
        )}
        {d.takeaway && (
          <div style={{ marginTop: n(8), color: '#c8b888', fontSize: n(compact ? 10.5 : 12), lineHeight: 1.45 }}>
            {d.takeaway}
          </div>
        )}
        <div style={{ display: 'flex', gap: n(8), marginTop: n(compact ? 12 : 18), flexWrap: 'wrap' }}>
          {buttons.map((b, i) => (
            <button key={b.action} onClick={() => EventBus.emit('flight:lesson-exit', { action: b.action })} style={{
              cursor: 'pointer', fontFamily: 'monospace', fontWeight: 'bold',
              fontSize: n(compact ? 11 : 13), letterSpacing: 1,
              minHeight: compact ? 36 : 40, padding: `0 ${n(14)}px`, borderRadius: 3,
              color: i === 0 ? '#1a1206' : AMBER,
              background: i === 0 ? AMBER : 'rgba(255,214,140,0.06)',
              border: `1px solid ${i === 0 ? AMBER : '#6b5624'}`,
            }}>{b.label}{i === 0 ? '  ⏎' : ''}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
