import React from 'react';
import { EventBus } from '../../../game/utils/EventBus';
import { SoundEngine } from '../../../game/audio/SoundEngine';
import { SaveService } from '../../../services/SaveService';
import { lessonList, lessonUnlocked, schoolDone } from '../../../game/training/lessons';
import { useViewport } from '../../viewport';
import { panelChrome } from './panelChrome';

/**
 * Flight school: the lessons, in order, with how each went.
 *
 * One row per lesson — a number, what it teaches, the stars it earned and
 * a Play button. The lesson to fly next is lit; the ones after it are locked
 * until the one before has a star. Contracts open when every lesson has one.
 */

const AMBER = '#ffd080';
const BONE = '#e8d5b7';
const ASH = '#8a7a5a';
const GREEN = '#9fe8b0';
const DIM = '#3a3222';

export function FlightSchoolScreen(): React.ReactElement {
  const vp = useViewport();
  const chrome = panelChrome(vp, 640, 540);
  const n = (v: number): number => Math.round(v * vp.uiScale);
  const compact = vp.isCompact;

  const stats = SaveService.get().player.stats;
  const stars = stats.lessonStars ?? {};
  const lessons = lessonList();
  const passed = lessons.filter(l => (stars[l.id] ?? 0) > 0).length;
  const done = schoolDone(stats);
  // The lesson to fly next: the first one without a star
  const nextId = lessons.find(l => (stars[l.id] ?? 0) === 0)?.id ?? null;

  const close = (): void => { SoundEngine.click(); EventBus.emit('ui:close-flight-school'); };
  const play = (id: string): void => { SoundEngine.click(); EventBus.emit('flight:start-lesson', { lessonId: id }); };

  return (
    <div style={{ ...chrome.backdrop, background: 'rgba(6,4,2,0.55)', zIndex: 450 }}>
      <div style={{ ...chrome.panel, borderRadius: 4, borderTop: `3px solid ${AMBER}` }}>
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div style={{ padding: `${n(compact ? 10 : 16)}px ${n(compact ? 14 : 20)}px ${n(compact ? 8 : 12)}px`, borderBottom: '1px solid #2a2114' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: n(10) }}>
            <span style={{ fontSize: n(compact ? 15 : 19), fontWeight: 'bold', color: AMBER, letterSpacing: 3 }}>FLIGHT SCHOOL</span>
            <button onClick={close} style={{
              background: 'none', border: '1px solid #3a2f1a', color: ASH, cursor: 'pointer',
              fontFamily: 'monospace', fontSize: n(12), padding: `${n(4)}px ${n(10)}px`, borderRadius: 3, minHeight: 32,
            }}>Close ✕</button>
          </div>
          <div style={{ marginTop: n(6), fontSize: n(compact ? 10.5 : 12), color: done ? GREEN : BONE }}>
            {done
              ? 'Contracts are open. Fly any lesson again to improve your stars.'
              : `${passed} of ${lessons.length} lessons passed — pass every one to fly contracts.`}
          </div>
          <div style={{ display: 'flex', gap: 3, marginTop: n(8) }}>
            {lessons.map(l => (
              <span key={l.id} style={{
                flex: 1, height: n(4), borderRadius: 2,
                background: (stars[l.id] ?? 0) > 0 ? GREEN : l.id === nextId ? AMBER : DIM,
              }} />
            ))}
          </div>
        </div>

        {/* ── The lessons ────────────────────────────────────────────────── */}
        <div className="aa-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: `${n(8)}px ${n(compact ? 10 : 14)}px` }}>
          {lessons.map(l => {
            const s = stars[l.id] ?? 0;
            const open = lessonUnlocked(l.id, stars);
            const isNext = l.id === nextId;
            const badge = s > 0 ? GREEN : isNext ? AMBER : open ? BONE : DIM;
            return (
              <div key={l.id} style={{
                display: 'flex', alignItems: 'center', gap: n(12),
                padding: `${n(compact ? 8 : 12)}px ${n(compact ? 10 : 14)}px`,
                marginBottom: n(8), borderRadius: 4,
                background: isNext ? 'rgba(255,208,128,0.09)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${isNext ? AMBER : '#2a2114'}`,
                opacity: open ? 1 : 0.55,
              }}>
                <span style={{
                  flexShrink: 0, width: n(34), height: n(34), borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: `2px solid ${badge}`, color: badge, fontWeight: 'bold', fontSize: n(15),
                }}>{s > 0 ? '✓' : l.n}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: n(10), flexWrap: 'wrap' }}>
                    <span style={{ fontSize: n(compact ? 12.5 : 15), fontWeight: 'bold', color: open ? BONE : ASH }}>{l.title}</span>
                    <span aria-label={`${s} of 3 stars`} style={{ fontSize: n(compact ? 12 : 14), letterSpacing: 2 }}>
                      {[0, 1, 2].map(i => <span key={i} style={{ color: i < s ? AMBER : DIM }}>★</span>)}
                    </span>
                  </span>
                  <span style={{ display: 'block', marginTop: n(2), fontSize: n(compact ? 10 : 11.5), color: ASH, lineHeight: 1.35 }}>
                    {open ? l.blurb : `🔒 Pass lesson ${l.n - 1} first`}
                  </span>
                </span>
                {open && (
                  <button onClick={() => play(l.id)} style={{
                    flexShrink: 0, cursor: 'pointer', fontFamily: 'monospace', fontWeight: 'bold',
                    fontSize: n(compact ? 11.5 : 13), minHeight: 38, padding: `0 ${n(14)}px`, borderRadius: 3,
                    color: isNext ? '#1a1206' : AMBER,
                    background: isNext ? AMBER : 'transparent',
                    border: `1px solid ${isNext ? AMBER : '#6b5624'}`,
                  }}>{s > 0 ? 'Fly again' : 'Play ▸'}</button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
