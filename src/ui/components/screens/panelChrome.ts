import type React from 'react';
import type { ViewportInfo } from '../../viewport';

/**
 * Shared chrome for the full-screen panels (hangar, profiles, contract board).
 *
 * These were all authored at a fixed size — the hangar was a hard 940×560 box.
 * Centred inside a viewport SMALLER than that, flexbox centring pushes the
 * overflow off BOTH edges, so on a phone the panel's own header, money readout
 * and CLOSE button ended up above the top of the screen: the player could not
 * even dismiss it. Capping the panel at the viewport and letting the body
 * scroll is the fix, and it is the same fix for every one of them.
 */
export function panelChrome(
  vp: ViewportInfo,
  maxW = 940,
  maxH = 560,
): { backdrop: React.CSSProperties; panel: React.CSSProperties } {
  const gap = vp.isCompact ? 6 : 16;
  return {
    backdrop: {
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'monospace',
      // Safe-area padding so a notch or a home indicator never eats the header
      padding: `calc(${gap}px + env(safe-area-inset-top, 0px))`
        + ` calc(${gap}px + env(safe-area-inset-right, 0px))`
        + ` calc(${gap}px + env(safe-area-inset-bottom, 0px))`
        + ` calc(${gap}px + env(safe-area-inset-left, 0px))`,
      // Panels are modal: they take the pointer back from the transparent
      // overlay wrapper.
      pointerEvents: 'auto',
    },
    panel: {
      width: `min(${maxW}px, 100%)`,
      maxHeight: '100%',
      height: `min(${maxH}px, 100%)`,
      background: '#100d07',
      border: '1px solid #3a2f1a',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,     // lets the scrolling body actually shrink
      overflow: 'hidden',
    },
  };
}

/** The smallest reliably tappable target on a touchscreen. */
export const TAP_MIN = 44;

/** Grow a control to a comfortable tap target on touch devices only. */
export function tappable(vp: ViewportInfo, base: React.CSSProperties): React.CSSProperties {
  if (!vp.isTouch) return base;
  return { ...base, minHeight: TAP_MIN, minWidth: TAP_MIN };
}
