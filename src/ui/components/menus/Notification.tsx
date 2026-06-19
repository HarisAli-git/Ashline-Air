import React from 'react';
import { useNotification } from '../../store/gameStore';

const COLOR: Record<string, string> = {
  info:    '#88ccff',
  warning: '#ffd080',
  danger:  '#ff4444',
  success: '#00ff88',
};

export function GlobalNotification(): React.ReactElement | null {
  const note = useNotification();
  if (!note) return null;
  return (
    <div style={{
      position: 'fixed',
      top: 20,
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(10,8,4,0.94)',
      border: `1px solid ${COLOR[note.type] ?? '#888'}`,
      padding: '10px 24px',
      fontFamily: 'monospace',
      fontSize: 15,
      color: '#e8d5b7',
      zIndex: 500,
      borderRadius: 4,
      pointerEvents: 'none',
    }}>
      {note.message}
    </div>
  );
}
