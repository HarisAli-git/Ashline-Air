import type React from 'react';

export type HudStyles = Record<string, React.CSSProperties>;

/**
 * Height of the bottom instrument strip, in CSS pixels.
 *
 * Exported because the on-screen flight controls have to sit ABOVE it — the
 * throttle lever and the pitch stick were originally offset by a guessed
 * constant and ended up half-buried under the panel on a short screen.
 */
export function hudPanelHeight(uiScale: number, compact: boolean): number {
  return Math.round((compact ? 44 : 74) * uiScale);
}

/**
 * The HUD is laid out for the screen it is on, not scaled from one design.
 *
 * `compact` is a different layout, not a smaller one: on a 390 px-tall phone
 * the full desktop strip took a fifth of the screen and wrapped its own values
 * onto two lines. Compact drops the artificial horizon and the secondary
 * gauges, shortens the units, and halves the vertical budget.
 */
export function hudStyles(uiScale: number, compact: boolean): HudStyles {
  const s = uiScale;
  const n = (v: number): number => Math.round(v * s);
  const panelH = hudPanelHeight(uiScale, compact);

  return {
    routeStrip: {
      position: 'absolute',
      top: `calc(${n(8)}px + env(safe-area-inset-top, 0px))`,
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      alignItems: 'center',
      gap: n(8),
      // Never wider than the screen it is drawn on — a fixed 520 px strip
      // overhung both edges of a phone.
      width: compact ? 'min(80vw, 420px)' : 'min(70vw, 520px)',
      padding: `${n(5)}px ${n(12)}px`,
      background: 'rgba(10,8,4,0.75)',
      border: '1px solid #3a2a10',
      borderRadius: 4,
      fontFamily: 'monospace',
      zIndex: 90,
    },
    routeDot: { width: n(8), height: n(8), borderRadius: '50%', flexShrink: 0 },
    routeTrack: { position: 'relative', flex: 1, height: 4, background: '#241a0c', borderRadius: 2 },
    routeFill: { position: 'absolute', left: 0, top: 0, height: '100%', background: '#5a4a20', borderRadius: 2 },
    planeMarker: { position: 'absolute', top: -n(9), fontSize: n(13), color: '#ffd080', transition: 'left 0.4s linear' },
    routeLabel: { fontSize: n(compact ? 9 : 11), color: '#c8b888', whiteSpace: 'nowrap', flexShrink: 0 },

    panel: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: panelH,
      display: 'flex',
      alignItems: 'center',
      // space-evenly keeps the row filling the width at any size instead of
      // bunching left with a fixed gap and overflowing on a narrow screen.
      justifyContent: compact ? 'space-evenly' : 'flex-start',
      gap: compact ? n(4) : n(22),
      padding: compact
        ? `0 calc(${n(8)}px + env(safe-area-inset-left, 0px)) env(safe-area-inset-bottom, 0px)`
        : `${n(8)}px ${n(24)}px ${n(10)}px`,
      background: 'linear-gradient(180deg, rgba(16,12,6,0.92) 0%, rgba(8,6,3,0.95) 100%)',
      borderTop: '2px solid #3a2a10',
      boxShadow: '0 -4px 18px rgba(0,0,0,0.55)',
      fontFamily: 'monospace',
      zIndex: 100,
      overflow: 'hidden',
    },

    annunciators: {
      position: 'absolute',
      top: `calc(${n(compact ? 74 : 92)}px + env(safe-area-inset-top, 0px))`,
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: n(5),
      zIndex: 150,
      pointerEvents: 'none',
      maxWidth: '92vw',
    },
    caution: {
      border: '1px solid',
      borderRadius: 3,
      padding: `${n(3)}px ${n(11)}px`,
      fontFamily: 'monospace',
      fontSize: n(compact ? 11 : 13),
      fontWeight: 'bold',
      letterSpacing: compact ? 1 : 2,
      background: 'rgba(10,8,4,0.85)',
      textAlign: 'center',
    },

    adi: {
      position: 'relative', width: n(46), height: n(46), borderRadius: '50%',
      overflow: 'hidden', border: '2px solid #3a2a10', flexShrink: 0,
    },
    adiCard: { position: 'absolute', left: 0, top: '-50%', width: '100%', height: '200%', transition: 'transform 0.12s linear' },
    adiSky: { position: 'absolute', top: 0, width: '100%', height: '50%', background: '#3d5a74' },
    adiGround: { position: 'absolute', top: '50%', width: '100%', height: '50%', background: '#5a4226' },
    adiHorizon: { position: 'absolute', top: 'calc(50% - 1px)', width: '100%', height: 2, background: '#e8d5b7' },
    adiWingL: { position: 'absolute', top: 'calc(50% - 1px)', left: 5, width: 12, height: 2, background: '#ffd080' },
    adiWingR: { position: 'absolute', top: 'calc(50% - 1px)', right: 5, width: 12, height: 2, background: '#ffd080' },
    adiDot: { position: 'absolute', top: 'calc(50% - 2px)', left: 'calc(50% - 2px)', width: 4, height: 4, borderRadius: '50%', background: '#ffd080' },

    gauge: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      minWidth: compact ? n(38) : n(64),
      gap: compact ? 0 : 2,
      lineHeight: 1.15,
    },
    gaugeLabel: {
      fontSize: n(compact ? 8 : 10),
      color: '#6a5a3a',
      letterSpacing: compact ? 1 : 2,
      whiteSpace: 'nowrap',
    },
    gaugeValue: {
      fontSize: n(compact ? 13 : 16),
      color: '#e8d5b7',
      fontWeight: 'bold',
      whiteSpace: 'nowrap',
    },
    barBg: { width: compact ? n(30) : n(56), height: compact ? 2 : 3, background: '#241a0c', borderRadius: 2, overflow: 'hidden' },
    barFill: { height: '100%', borderRadius: 2 },

    toggles: {
      display: 'flex',
      flexDirection: 'column',
      gap: compact ? 0 : 4,
      fontSize: n(compact ? 9 : 13),
      fontFamily: 'monospace',
      lineHeight: 1.25,
      whiteSpace: 'nowrap',
      marginLeft: compact ? 0 : 'auto',
      paddingRight: `calc(${n(4)}px + env(safe-area-inset-right, 0px))`,
    },

    modalBackdrop: {
      position: 'absolute',
      inset: 0,
      background: 'rgba(0,0,0,0.75)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 300,
      padding: n(12),
      // The modal is the one thing in the HUD that takes input.
      pointerEvents: 'auto',
    },
    modal: {
      background: '#1a1208',
      border: '1px solid #5a4a20',
      padding: compact ? `${n(16)}px ${n(18)}px` : `${n(28)}px ${n(36)}px`,
      maxWidth: n(520),
      width: '92%',
      // Long events must not push their own choices off a short screen.
      maxHeight: '86%',
      overflowY: 'auto',
      fontFamily: 'monospace',
      borderRadius: 4,
    },
    modalTitle: { color: '#ffd080', fontSize: n(compact ? 16 : 22), marginBottom: n(10) },
    modalDesc: { color: '#c8b888', fontSize: n(compact ? 12 : 15), lineHeight: 1.55, marginBottom: n(compact ? 14 : 22) },
    choices: { display: 'flex', flexDirection: 'column', gap: n(9) },
    choiceBtn: {
      background: 'transparent',
      border: '1px solid #5a4a20',
      color: '#e8d5b7',
      fontFamily: 'monospace',
      fontSize: n(compact ? 12 : 14),
      // 44 px is the smallest reliably tappable target on a touchscreen.
      minHeight: 44,
      padding: `${n(9)}px ${n(14)}px`,
      cursor: 'pointer',
      textAlign: 'left',
      borderRadius: 2,
    },
  };
}
