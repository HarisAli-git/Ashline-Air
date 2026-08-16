import React from 'react';
import { useViewport } from '../viewport';

/**
 * Held upright, a phone gives a side-scrolling flight sim almost no usable
 * width: the design canvas clamps to its minimum, FIT scales it to the narrow
 * dimension, and the game ends up a letterboxed strip with a HUD too small to
 * read. Asking for a rotation is the honest answer — squeezing the cockpit into
 * a portrait column would be a worse game, not a smaller one.
 *
 * Only shown on touch devices: a desktop window that happens to be tall and
 * narrow is the player's own choice and simply letterboxes.
 */
export function OrientationGate(): React.ReactElement | null {
  const vp = useViewport();
  if (!vp.isTouch || !vp.isPortrait) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0d0a04',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 18,
        zIndex: 9999,
        padding: 24,
        textAlign: 'center',
        color: '#e8d5b7',
        fontFamily: 'monospace',
      }}
    >
      <div
        style={{
          width: 74,
          height: 116,
          border: '3px solid #5a4a20',
          borderRadius: 12,
          animation: 'aa-rotate-hint 2.4s ease-in-out infinite',
        }}
      />
      <div style={{ fontSize: 19, letterSpacing: 3, color: '#ffd080' }}>ROTATE YOUR DEVICE</div>
      <div style={{ fontSize: 13, color: '#8a7a5a', maxWidth: 300, lineHeight: 1.5 }}>
        Ashline Air is flown sideways. Turn your phone to landscape to take off.
      </div>
      <style>{`
        @keyframes aa-rotate-hint {
          0%, 100% { transform: rotate(0deg); }
          45%, 85% { transform: rotate(-90deg); }
        }
      `}</style>
    </div>
  );
}
