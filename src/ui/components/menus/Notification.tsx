import React from 'react';
import { useNotification, useInFlight } from '../../store/gameStore';
import { useViewport } from '../../viewport';

const COLOR: Record<string, string> = {
  info:    '#88ccff',
  warning: '#ffd080',
  danger:  '#ff4444',
  success: '#00ff88',
};

export function GlobalNotification(): React.ReactElement | null {
  const note = useNotification();
  const inFlight = useInFlight();
  const vp = useViewport();
  if (!note) return null;
  const s = vp.uiScale;
  const n = (v: number): number => Math.round(v * s);
  return (
    <div style={{
      // absolute, not fixed: it belongs to the canvas rect like the rest of the
      // overlay, so it stays registered with the game inside any letterbox.
      position: 'absolute',
      /*
       * Where it sits depends on what is underneath it.
       *
       * In flight the top belongs to the radio strip and the caution chips, and
       * the HUD redesign left the bottom centre completely clear — so a toast
       * goes there. Everywhere ELSE the bottom centre is exactly where the
       * primary action button lives (FLY, ACCEPT, RETURN TO MAP), and a toast
       * about the contract you just chose landed straight on top of the button
       * you chose it with. Off the flight screen it goes to the top instead.
       */
      ...(inFlight
        ? { bottom: `calc(${n(vp.isCompact ? 30 : 40)}px + env(safe-area-inset-bottom, 0px))` }
        : { top: `calc(${n(vp.isCompact ? 46 : 58)}px + env(safe-area-inset-top, 0px))` }),
      left: '50%',
      transform: 'translateX(-50%)',
      maxWidth: '88vw',
      textAlign: 'center',
      background: 'rgba(10,8,4,0.94)',
      border: `1px solid ${COLOR[note.type] ?? '#888'}`,
      padding: `${n(vp.isCompact ? 5 : 10)}px ${n(vp.isCompact ? 12 : 24)}px`,
      fontFamily: 'monospace',
      fontSize: n(vp.isCompact ? 12 : 15),
      color: '#e8d5b7',
      zIndex: 500,
      borderRadius: 4,
      pointerEvents: 'none',
    }}>
      {note.message}
    </div>
  );
}
