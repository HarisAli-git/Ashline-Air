import React from 'react';
import { useNotifications, useInFlight, type Note } from '../../store/gameStore';
import { useViewport } from '../../viewport';

/**
 * Messages, as lines on the glass rather than a box.
 *
 * The old toast was one opaque bordered panel, 15 px, centred at the bottom —
 * the heaviest thing on the flight screen, for messages that were mostly
 * routine. In flight these are now thin strips in the HUD's own language: a
 * colour tick for how much it matters, the words, and a ×N when the same
 * thing is said again. Two at most in the air, so a burst of radio traffic
 * cannot bury the screen; the queue behind it decides what is worth showing.
 */

const TONE: Record<string, string> = {
  info:    '#c8b888',
  warning: '#ffd080',
  danger:  '#ff5a44',
  success: '#9fe8b0',
};

const ETCH = '0 1px 0 rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.85)';

export function GlobalNotification(): React.ReactElement | null {
  const inFlight = useInFlight();
  const vp = useViewport();
  const notes = useNotifications(inFlight ? 2 : 3);
  if (notes.length === 0) return null;
  const s = vp.uiScale;
  const n = (v: number): number => Math.round(v * s);
  const compact = vp.isCompact;

  return (
    <div style={{
      position: 'absolute',
      /*
       * In flight the top belongs to the cautions and the radio strip and the
       * bottom corners to the instruments, so messages run up from the
       * bottom centre. Everywhere else the bottom centre is where the primary
       * button lives, so they come down from the top instead.
       */
      ...(inFlight
        ? { bottom: `calc(${n(compact ? 24 : 34)}px + env(safe-area-inset-bottom, 0px))` }
        : { top: `calc(${n(compact ? 46 : 58)}px + env(safe-area-inset-top, 0px))` }),
      left: '50%',
      transform: 'translateX(-50%)',
      width: inFlight ? (compact ? '54%' : 'min(600px, 52%)') : 'min(620px, 88vw)',
      display: 'flex',
      flexDirection: inFlight ? 'column' : 'column-reverse',
      alignItems: 'center',
      gap: n(3),
      zIndex: 500,
      pointerEvents: 'none',
    }}>
      {notes.map(note => <Line key={`${note.id}-${note.born}`} note={note} n={n} compact={compact} inFlight={inFlight} />)}
    </div>
  );
}

function Line({ note, n, compact, inFlight }: {
  note: Note; n: (v: number) => number; compact: boolean; inFlight: boolean;
}): React.ReactElement {
  const tone = TONE[note.type] ?? TONE.info;
  const loud = note.type === 'danger' || note.type === 'warning';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: n(8),
      maxWidth: '100%',
      background: inFlight
        ? `linear-gradient(90deg, rgba(10,8,4,${loud ? 0.82 : 0.7}) 0%, rgba(10,8,4,${loud ? 0.72 : 0.55}) 100%)`
        : 'rgba(12,9,4,0.92)',
      borderLeft: `3px solid ${tone}`,
      borderRadius: 2,
      padding: `${n(compact ? 3 : 4)}px ${n(compact ? 9 : 12)}px`,
      fontFamily: 'monospace',
      fontSize: n(compact ? (inFlight ? 10.5 : 11.5) : (inFlight ? 12.5 : 13.5)),
      fontWeight: loud ? 'bold' : 'normal',
      lineHeight: 1.3,
      color: loud ? tone : '#e8d5b7',
      textShadow: ETCH,
      boxShadow: '0 3px 12px rgba(0,0,0,0.35)',
      animation: `aa-note ${note.ttl}ms linear forwards`,
    }}>
      <span style={{
        // Two lines at most on a phone; the rest of a long call is not worth the screen
        display: '-webkit-box', WebkitLineClamp: compact ? 2 : 3, WebkitBoxOrient: 'vertical' as const,
        overflow: 'hidden',
      }}>{note.message}</span>
      {note.count > 1 && (
        <span style={{
          flexShrink: 0, fontSize: n(compact ? 9 : 10), color: tone,
          border: `1px solid ${tone}`, borderRadius: 2, padding: `0 ${n(4)}px`,
        }}>×{note.count}</span>
      )}
    </div>
  );
}
