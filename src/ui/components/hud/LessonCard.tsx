import React, { useEffect, useState } from 'react';
import { EventBus } from '../../../game/utils/EventBus';
import { ctl } from '../../../game/utils/controls';
import type { LessonView } from '../../../game/training/LessonRunner';

/**
 * The lesson, one goal at a time.
 *
 * The old panel was a heading and a paragraph per step. This is one line —
 * what to do now — with the key that does it and pips for where you are in
 * the lesson. When a goal is done it is ticked off in green for a moment
 * before the next one arrives, so progress is something you see happen.
 */

const AMBER = '#ffd080';
const BONE = '#e8d5b7';
const ASH = '#8a7a5a';
const GREEN = '#9fe8b0';
const ETCH = '0 1px 0 rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.85)';

export function LessonCard({ view, scale, compact, touch }: {
  view: LessonView; scale: number; compact: boolean; touch: boolean;
}): React.ReactElement {
  const n = (v: number): number => Math.round(v * scale);
  // The goal just finished, held on screen for a beat
  const [ticked, setTicked] = useState<string | null>(null);
  useEffect(() => {
    if (!view.justDone) return;
    setTicked(view.justDone);
    const t = setTimeout(() => setTicked(null), 1400);
    return () => clearTimeout(t);
  }, [view.justDone, view.step]);

  return (
    <div style={{
      position: 'absolute',
      ...(compact
        ? { top: `calc(${n(6)}px + env(safe-area-inset-top, 0px))`, left: '38%', width: touch ? '48%' : '58%' }
        : { top: `calc(${n(14)}px + env(safe-area-inset-top, 0px))`, right: `calc(${n(16)}px + env(safe-area-inset-right, 0px))`, width: 'min(440px, 36%)' }),
      pointerEvents: 'none', zIndex: 260, fontFamily: 'monospace', textShadow: ETCH,
    }}>
      <div style={{
        background: 'linear-gradient(180deg, rgba(12,9,4,0.88) 0%, rgba(12,9,4,0.76) 100%)',
        borderLeft: `3px solid ${AMBER}`, borderRadius: 3,
        padding: `${n(compact ? 6 : 9)}px ${n(compact ? 10 : 14)}px ${n(compact ? 7 : 10)}px`,
        boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: n(8) }}>
          <span style={{ fontSize: n(compact ? 8.5 : 9.5), letterSpacing: 2, color: ASH, whiteSpace: 'nowrap' }}>
            LESSON {view.n} · {view.title.toUpperCase()}
          </span>
          <span style={{ display: 'flex', gap: 2, flex: 1, minWidth: 0 }} aria-label={`goal ${view.step} of ${view.total}`}>
            {Array.from({ length: view.total }, (_, i) => (
              <span key={i} style={{
                flex: 1, height: n(3), borderRadius: 1,
                background: i < view.step - 1 ? GREEN : i === view.step - 1 ? AMBER : 'rgba(138,122,90,0.35)',
                transition: 'background 0.3s',
              }} />
            ))}
          </span>
          <button
            onClick={() => EventBus.emit('flight:lesson-exit', { action: 'school' })}
            style={{
              pointerEvents: 'auto', background: 'none', border: 'none', cursor: 'pointer',
              color: ASH, fontFamily: 'monospace', fontSize: n(compact ? 9 : 10), letterSpacing: 1,
              padding: `${n(2)}px 0 ${n(2)}px ${n(4)}px`, minHeight: touch ? 28 : undefined,
            }}
          >Quit</button>
        </div>
        {ticked && (
          <div style={{
            marginTop: n(compact ? 4 : 6), color: GREEN, fontSize: n(compact ? 10 : 11.5),
            animation: 'aa-step 0.25s ease-out',
          }}>✓ {ticked}</div>
        )}
        {/* Re-keyed per goal so each one arrives rather than just changing */}
        <div key={view.step} style={{
          marginTop: n(compact ? 4 : 6), display: 'flex', alignItems: 'center',
          gap: n(10), flexWrap: 'wrap', animation: 'aa-step 0.35s ease-out',
        }}>
          <span style={{
            fontSize: n(compact ? 12 : 15), fontWeight: 'bold', color: BONE, lineHeight: 1.3,
          }}>{view.text}</span>
          {view.keys.length > 0 && (
            <span style={{ display: 'flex', gap: n(5) }}>
              {view.keys.map(k => (
                <kbd key={k} style={{
                  fontFamily: 'monospace', fontSize: n(compact ? 10 : 12), fontWeight: 'bold',
                  color: AMBER, background: 'rgba(255,214,140,0.10)',
                  border: '1px solid #6b5624', borderBottomWidth: 2, borderRadius: 3,
                  padding: `0 ${n(7)}px`, lineHeight: `${n(compact ? 17 : 20)}px`, whiteSpace: 'nowrap',
                }}>{ctl(k)}</kbd>
              ))}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
