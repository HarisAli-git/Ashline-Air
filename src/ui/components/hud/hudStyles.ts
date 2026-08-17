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
      // On a phone a centred box is the wrong shape: it fights the on-screen
      // controls for the middle of a 390 px-tall screen. A bottom sheet uses
      // the edge nobody is flying with.
      alignItems: compact ? 'flex-end' : 'center',
      justifyContent: 'center',
      zIndex: 300,
      padding: compact ? 0 : n(12),
      pointerEvents: 'auto',
    },
    modal: {
      background: 'linear-gradient(180deg, #1d1509 0%, #140f07 100%)',
      border: '1px solid #6b5624',
      borderWidth: compact ? '1px 0 0' : 1,
      // Instrument-panel bezel: a lit top edge and a deep drop shadow
      boxShadow: 'inset 0 1px 0 rgba(255,214,140,0.18), 0 14px 40px rgba(0,0,0,0.7)',
      padding: compact
        ? `${n(9)}px ${n(13)}px calc(${n(10)}px + env(safe-area-inset-bottom, 0px))`
        : `${n(20)}px ${n(26)}px ${n(22)}px`,
      maxWidth: compact ? '100%' : n(560),
      width: compact ? '100%' : '92%',
      maxHeight: compact ? '58%' : '86%',
      overflowY: 'auto',
      fontFamily: 'monospace',
      borderRadius: compact ? '10px 10px 0 0' : 3,
    },
    // ── Channel strip: this came in over the radio, so it says so ────────
    modalChannel: {
      display: 'flex',
      alignItems: 'center',
      gap: n(7),
      marginBottom: n(compact ? 6 : 10),
    },
    modalLive: {
      width: n(6), height: n(6), borderRadius: '50%',
      background: '#ff4a3a', boxShadow: '0 0 6px #ff4a3a',
      flexShrink: 0,
      animation: 'aa-live 1.6s steps(1, end) infinite',
    },
    modalChannelText: {
      fontSize: n(compact ? 8 : 9),
      letterSpacing: 2,
      color: '#8a7a5a',
      whiteSpace: 'nowrap',
    },
    modalChannelRule: { flex: 1, height: 1, background: 'linear-gradient(90deg,#5a4a20,transparent)' },
    modalTitle: {
      color: '#ffd080',
      fontSize: n(compact ? 15 : 21),
      letterSpacing: compact ? 0.5 : 1.5,
      textTransform: 'uppercase',
      lineHeight: 1.2,
      marginBottom: n(compact ? 5 : 9),
      textShadow: '0 0 14px rgba(255,208,128,0.25)',
    },
    modalDesc: {
      color: '#bdae8c',
      fontSize: n(compact ? 11 : 14),
      lineHeight: compact ? 1.45 : 1.6,
      marginBottom: n(compact ? 10 : 18),
    },
    choices: { display: 'flex', flexDirection: 'column', gap: n(compact ? 6 : 9) },
    choiceBtn: {
      // A switch on the panel, not a web button: a numbered key plate, the
      // action, and underneath it exactly what throwing it will cost.
      display: 'flex',
      alignItems: 'stretch',
      gap: n(10),
      background: 'rgba(255,214,140,0.035)',
      border: '1px solid #4a3c1a',
      borderLeft: '3px solid #8a6a2a',
      color: '#e8d5b7',
      fontFamily: 'monospace',
      minHeight: 44,
      padding: `${n(compact ? 7 : 9)}px ${n(11)}px`,
      cursor: 'pointer',
      textAlign: 'left',
      borderRadius: 2,
    },
    choiceKey: {
      flexShrink: 0,
      width: n(18), height: n(18),
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: '1px solid #6b5624',
      borderRadius: 2,
      color: '#ffd080',
      fontSize: n(compact ? 9 : 11),
      alignSelf: 'center',
    },
    choiceBody: { display: 'flex', flexDirection: 'column', gap: n(2), minWidth: 0 },
    choiceLabel: {
      fontSize: n(compact ? 12 : 14),
      lineHeight: 1.3,
      color: '#f0e2c4',
    },
    choiceCost: {
      fontSize: n(compact ? 9 : 10.5),
      lineHeight: 1.35,
      color: '#8a7a5a',
    },
  };
}
