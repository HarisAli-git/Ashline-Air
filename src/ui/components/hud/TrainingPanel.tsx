import React, { useEffect, useState } from 'react';
import { EventBus } from '../../../game/utils/EventBus';

/**
 * Flight school on the glass: the step you are on, what to do, and the key
 * that does it.
 *
 * The first-flight hints were one line of amber text, which is enough to say
 * "press E" and not enough to teach anything. A lesson needs three things a
 * line cannot carry: where you are in it (so it has an end), a heading that
 * names the skill (so you remember it), and the actual keycap (so you are not
 * hunting the legend). Still a wash on the world rather than a panel, and
 * still bottom centre — the only part of the screen the HUD leaves clear.
 */

export interface TutorialPayload {
  text: string;
  title?: string;
  step?: number;
  total?: number;
  keys?: string[];
  training?: boolean;
  /** From the coach on any flight, not just flight school. */
  coach?: boolean;
}

const AMBER = '#ffd080';
const BONE = '#e8d5b7';
const ASH = '#8a7a5a';
const GREEN = '#9fe8b0';
const ETCH = '0 1px 0 rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.85)';

export function TrainingPanel({ lesson, scale, compact, touch }: {
  lesson: TutorialPayload; scale: number; compact: boolean; touch: boolean;
}): React.ReactElement {
  const n = (v: number): number => Math.round(v * scale);
  const step = lesson.step ?? 1;
  const total = lesson.total ?? 1;
  // The takeoff sequence is numbered; a one-off lesson mid-flight is not
  const sequenced = lesson.step !== undefined && lesson.total !== undefined;
  const label = lesson.training ? 'FLIGHT SCHOOL' : sequenced ? 'FIRST FLIGHT' : 'NEW';
  return (
    <div style={{
      position: 'absolute',
      /*
       * On a phone the bottom band is the ground ahead — exactly where the
       * drop reticle and the people you are aiming at are — so the lesson
       * docks at the top instead, over empty sky, and the caution chips
       * move down under it (hudStyles `lessonOnTop`).
       */
      /*
       * Never over the ground ahead. The bottom of the screen is where the
       * runway, the people you are dropping to and the aim point all are —
       * the panel sat right on the target during the release lesson. On a
       * phone it docks at the top over empty sky; on a desktop it takes the
       * top-right corner, the one part of the HUD nothing else uses.
       */
      ...(compact
        ? { top: `calc(${n(6)}px + env(safe-area-inset-top, 0px))`, left: '40%', width: touch ? '45%' : '56%' }
        : { top: `calc(${n(14)}px + env(safe-area-inset-top, 0px))`, right: `calc(${n(16)}px + env(safe-area-inset-right, 0px))`, width: 'min(460px, 36%)' }),
      pointerEvents: 'none', zIndex: 260,
    }}>
      {/* Re-keyed per step so each new lesson arrives rather than just changing */}
      <div key={`${step}-${lesson.title}`} style={{
        background: 'linear-gradient(180deg, rgba(12,9,4,0.86) 0%, rgba(12,9,4,0.74) 100%)',
        borderLeft: `2px solid ${AMBER}`,
        borderRadius: 3,
        padding: `${n(compact ? 5 : 8)}px ${n(compact ? 9 : 14)}px ${n(compact ? 6 : 9)}px`,
        fontFamily: 'monospace',
        textShadow: ETCH,
        boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
        animation: 'aa-step 0.35s ease-out',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: n(8) }}>
          <span style={{
            fontSize: n(compact ? 8 : 9), letterSpacing: 2, color: ASH, whiteSpace: 'nowrap',
          }}>
            {label}{sequenced ? ` · ${step}/${total}` : ''}
          </span>
          {/* The sequence as ticks — a lesson you can see the end of */}
          <span style={{ display: 'flex', gap: 2, flex: 1, minWidth: 0 }} aria-hidden>
            {sequenced && Array.from({ length: total }, (_, i) => (
              <span key={i} style={{
                flex: 1, height: n(3), borderRadius: 1,
                background: i < step - 1 ? GREEN : i === step - 1 ? AMBER : 'rgba(138,122,90,0.35)',
              }} />
            ))}
          </span>
          <button
            onClick={() => EventBus.emit(lesson.training ? 'flight:skip-training' : 'flight:hide-tips')}
            style={{
              pointerEvents: 'auto', background: 'none', border: 'none', cursor: 'pointer',
              color: ASH, fontFamily: 'monospace', fontSize: n(compact ? 8.5 : 9.5),
              letterSpacing: 1, padding: `${n(2)}px 0 ${n(2)}px ${n(4)}px`, whiteSpace: 'nowrap',
              minHeight: touch ? 28 : undefined,
            }}
          >
            {lesson.training ? 'Skip ›' : 'Hide tips'}
          </button>
        </div>
        <div style={{
          marginTop: n(compact ? 3 : 5), display: 'flex', alignItems: 'baseline',
          gap: n(10), flexWrap: 'wrap',
        }}>
          <span style={{
            fontSize: n(compact ? 11 : 13.5), fontWeight: 'bold', letterSpacing: 1.5,
            color: AMBER, textTransform: 'uppercase',
          }}>{lesson.title}</span>
          {lesson.keys && lesson.keys.length > 0 && (
            <span style={{ display: 'flex', gap: n(5) }}>
              {lesson.keys.map(k => (
                <kbd key={k} style={{
                  fontFamily: 'monospace', fontSize: n(compact ? 9.5 : 11), fontWeight: 'bold',
                  color: BONE, background: 'rgba(255,214,140,0.08)',
                  border: '1px solid #6b5624', borderBottomWidth: 2, borderRadius: 3,
                  padding: `0 ${n(6)}px`, lineHeight: `${n(compact ? 15 : 18)}px`,
                }}>{k}</kbd>
              ))}
            </span>
          )}
        </div>
        <div style={{
          marginTop: n(compact ? 2 : 4), color: '#c8b888',
          fontSize: n(compact ? 10 : 12.5), lineHeight: 1.35,
        }}>{lesson.text}</div>
      </div>
    </div>
  );
}

interface Debrief {
  passed: boolean;
  reward: number;
  landing: string;
  onRunway: boolean;
  crates: number;
}

const LANDING_WORDS: Record<string, string> = {
  perfect: 'a greaser', good: 'a good landing', hard: 'a hard landing', crash: 'crashed',
};

/**
 * The end of the lesson, over the aeroplane wherever it stopped.
 *
 * Says what went right in the three things that matter — off the ground, a
 * crate on target, down on the strip — and offers the two things you might
 * want next. A crash gets the same card with a way straight back in.
 */
export function TrainingDebrief({ scale, compact }: { scale: number; compact: boolean }): React.ReactElement | null {
  const [d, setD] = useState<Debrief | null>(null);
  useEffect(() => {
    const u1 = EventBus.on('flight:training-complete', setD);
    // A fresh circuit starts clean
    const u2 = EventBus.on('flight:route-info', () => setD(null));
    return () => { u1(); u2(); };
  }, []);
  if (!d) return null;
  const n = (v: number): number => Math.round(v * scale);
  const row = (ok: boolean, text: string): React.ReactElement => (
    <div style={{ display: 'flex', gap: n(8), alignItems: 'baseline' }}>
      <span style={{ color: ok ? GREEN : '#ff8844', width: n(12) }}>{ok ? '✓' : '✗'}</span>
      <span style={{ color: ok ? BONE : ASH }}>{text}</span>
    </div>
  );
  const btn = (label: string, primary: boolean, again: boolean): React.ReactElement => (
    <button
      onClick={() => EventBus.emit('flight:training-exit', { again })}
      style={{
        pointerEvents: 'auto', cursor: 'pointer', fontFamily: 'monospace', fontWeight: 'bold',
        fontSize: n(compact ? 11 : 13), letterSpacing: 1,
        minHeight: compact ? 36 : 40, padding: `0 ${n(14)}px`, borderRadius: 3,
        color: primary ? '#1a1206' : AMBER,
        background: primary ? AMBER : 'rgba(255,214,140,0.06)',
        border: `1px solid ${primary ? AMBER : '#6b5624'}`,
      }}
    >{label}</button>
  );
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(6,4,2,0.35)', pointerEvents: 'auto', zIndex: 400,
    }}>
      <div style={{
        width: compact ? '70%' : 'min(460px, 60%)',
        background: 'linear-gradient(180deg, rgba(16,12,6,0.95) 0%, rgba(12,9,4,0.92) 100%)',
        borderTop: `2px solid ${d.passed ? GREEN : '#ff8844'}`,
        borderRadius: 4, padding: `${n(compact ? 10 : 16)}px ${n(compact ? 14 : 20)}px`,
        fontFamily: 'monospace', textShadow: ETCH, boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
        animation: 'aa-step 0.35s ease-out',
      }}>
        <div style={{ fontSize: n(9), letterSpacing: 2.5, color: ASH }}>FLIGHT SCHOOL</div>
        <div style={{
          fontSize: n(compact ? 16 : 20), fontWeight: 'bold', color: d.passed ? GREEN : '#ff8844',
          margin: `${n(2)}px 0 ${n(compact ? 6 : 10)}px`, letterSpacing: 1,
        }}>
          {d.passed ? 'Circuit flown' : d.landing === 'crash' ? 'You went in' : 'Down, but not on the strip'}
        </div>
        <div style={{ fontSize: n(compact ? 10.5 : 12.5), lineHeight: 1.6 }}>
          {row(true, 'Off the ground and cleaned up')}
          {row(d.crates > 0, d.crates > 0 ? 'Crate on target in Millbrook' : 'No crate reached Millbrook')}
          {row(d.passed, d.landing === 'crash'
            ? 'Crashed — it happens, the circuit is still there'
            : d.onRunway ? `On the strip — ${LANDING_WORDS[d.landing] ?? 'down safe'}` : 'Landed off the runway')}
        </div>
        {d.reward > 0 && (
          <div style={{ marginTop: n(8), color: AMBER, fontSize: n(compact ? 11 : 13), fontWeight: 'bold' }}>
            +₢{d.reward.toLocaleString()} — you are cleared to fly for hire
          </div>
        )}
        <div style={{ display: 'flex', gap: n(8), marginTop: n(compact ? 10 : 16), flexWrap: 'wrap' }}>
          {d.passed
            ? <>{btn('Continue to the map', true, false)}{btn('Fly it again', false, true)}</>
            : <>{btn('Try again', true, true)}{btn('Back to the map', false, false)}</>}
        </div>
      </div>
    </div>
  );
}
