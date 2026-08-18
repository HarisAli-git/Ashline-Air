import React from 'react';
import { useNotification } from '../../store/gameStore';
import { useViewport } from '../../viewport';

const COLOR: Record<string, string> = {
  info:    '#88ccff',
  warning: '#ffd080',
  danger:  '#ff4444',
  success: '#00ff88',
};

export function GlobalNotification(): React.ReactElement | null {
  const note = useNotification();
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
       * Bottom centre, not top.
       *
       * The top of the screen belongs to the radio strip and the caution
       * chips; a toast there landed straight through an incoming call. The
       * HUD redesign left the bottom centre completely clear, so that is
       * where transient messages go — nothing else ever occupies it.
       */
      bottom: `calc(${n(vp.isCompact ? 30 : 40)}px + env(safe-area-inset-bottom, 0px))`,
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
