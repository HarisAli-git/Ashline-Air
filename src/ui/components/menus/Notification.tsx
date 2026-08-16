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
      // Everything that stacks down the top of the screen shares one running
      // order — route strip (8), notification, annunciators — and the compact
      // numbers are spaced so no two can ever land on each other, or on a
      // scene's own header text underneath.
      top: `calc(${n(vp.isCompact ? 38 : 48)}px + env(safe-area-inset-top, 0px))`,
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
