import type React from 'react';

export type HudStyles = Record<string, React.CSSProperties>;

/**
 * Height of the HUD's bottom furniture, in CSS pixels.
 *
 * There is no instrument panel any more, so this is just the depth of the two
 * corner clusters — the number the on-screen flight controls need in order to
 * sit clear of them.
 */
export function hudPanelHeight(uiScale: number, compact: boolean): number {
  return Math.round((compact ? 62 : 78) * uiScale);
}

/**
 * "Marks on the glass."
 *
 * Every filled panel is gone. Readouts sit straight on the world with a hard
 * text shadow doing the work a background used to do, which is both what a
 * reflected HUD actually looks like and what gives a 390 px phone its screen
 * back. The palette is the game's own — bone, amber, ash — so the interface
 * reads as part of the aeroplane rather than a layer on top of it.
 */
export function hudStyles(
  uiScale: number, compact: boolean, touch = false, radioChoices = 0,
): HudStyles {
  const s = uiScale;
  const n = (v: number): number => Math.round(v * s);

  // The one thing holding legibility together now that nothing has a box
  const etch = '0 1px 0 rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.85)';

  // On a touch device the throttle lever hugs the left edge, so the primary
  // readout has to start to the right of it. On desktop there is no lever and
  // the readout goes right up against the edge where it belongs.
  const leverClearance = touch ? Math.round(44 * s) : 0;

  const safeL = 'env(safe-area-inset-left, 0px)';
  const safeR = 'env(safe-area-inset-right, 0px)';
  const safeB = 'env(safe-area-inset-bottom, 0px)';
  const safeT = 'env(safe-area-inset-top, 0px)';

  return {
    // ── Route: a 2 px hairline on the top edge ──────────────────────────
    routeRail: {
      position: 'absolute',
      top: `calc(${n(3)}px + ${safeT})`,
      left: '6%', right: '6%',
      height: 2,
      background: 'rgba(120,100,60,0.30)',
      borderRadius: 2,
      pointerEvents: 'none',
    },
    routeRailFill: {
      position: 'absolute', left: 0, top: 0, height: '100%',
      background: '#8a6a2a', borderRadius: 2,
    },
    routeRailPip: {
      position: 'absolute', top: -2, width: 6, height: 6,
      marginLeft: -3, borderRadius: '50%',
      background: '#ffd080', boxShadow: '0 0 6px #ffd080',
      transition: 'left 0.4s linear',
    },
    routeRailLabel: {
      position: 'absolute', top: n(6), right: 0,
      fontFamily: 'monospace', fontSize: n(compact ? 9 : 10),
      letterSpacing: 1, color: '#ffd080', textShadow: etch, whiteSpace: 'nowrap',
    },

    // ── Cautions: a tight column under the rail ─────────────────────────
    cautions: {
      position: 'absolute',
      /*
       * A call pushes the cautions below it rather than under it.
       *
       * Measured from the strip's actual content — header, body and one row
       * per choice — because a fixed offset is wrong the moment an event has
       * two options instead of three, and the chips end up hidden behind it.
       */
      top: `calc(${n(compact ? 14 : 18)
        + (radioChoices > 0
          ? n(compact ? 64 : 72) + radioChoices * n(compact ? 36 : 42)
          : 0)}px + ${safeT})`,
      left: '50%', transform: 'translateX(-50%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: n(3), pointerEvents: 'none', maxWidth: '80%',
    },
    chip: {
      // Just enough of a wash to hold the letterform against a bright sky
      background: 'rgba(8,6,3,0.45)',
      border: '1px solid',
      borderRadius: 2,
      padding: `${n(1.5)}px ${n(7)}px`,
      fontFamily: 'monospace',
      fontSize: n(compact ? 9.5 : 11),
      fontWeight: 'bold',
      letterSpacing: 1,
      textShadow: etch,
      whiteSpace: 'nowrap',
    },

    // ── Left cluster ────────────────────────────────────────────────────
    primary: {
      position: 'absolute',
      left: `calc(${n(10) + leverClearance}px + ${safeL})`,
      bottom: `calc(${n(8)}px + ${safeB})`,
      display: 'flex', alignItems: 'flex-end', gap: n(7),
      pointerEvents: 'none',
    },
    varioRail: {
      position: 'relative',
      width: n(4),
      height: n(compact ? 44 : 58),
      background: 'rgba(20,16,9,0.55)',
      borderRadius: 2,
      overflow: 'hidden',
    },
    varioZero: {
      position: 'absolute', left: 0, right: 0, top: '50%',
      height: 1, background: 'rgba(200,184,136,0.45)',
    },
    varioFill: {
      position: 'absolute', left: 0, right: 0, borderRadius: 2,
      transition: 'height 0.12s linear, top 0.12s linear',
    },
    primaryStack: { display: 'flex', flexDirection: 'column', gap: n(-1) },
    bigRow: { display: 'flex', alignItems: 'baseline', gap: n(3) },
    bigNum: {
      fontFamily: 'monospace',
      // The scale jump IS the hierarchy now that the boxes are gone
      fontSize: n(compact ? 26 : 34),
      fontWeight: 'bold',
      lineHeight: 1,
      color: '#e8d5b7',
      textShadow: etch,
      letterSpacing: -1,
    },
    bigNumAlt: { fontSize: n(compact ? 20 : 26), color: '#c8b888' },
    unit: {
      fontFamily: 'monospace', fontSize: n(compact ? 8 : 9),
      color: '#8a7a5a', textShadow: etch, letterSpacing: 1,
    },
    vs: {
      fontFamily: 'monospace', fontSize: n(compact ? 10 : 12),
      textShadow: etch, letterSpacing: 1, marginTop: n(1),
    },

    // ── Right cluster ───────────────────────────────────────────────────
    rightCluster: {
      position: 'absolute',
      right: `calc(${n(10) + (touch ? Math.round(72 * s) : 0)}px + ${safeR})`,
      bottom: `calc(${n(8)}px + ${safeB})`,
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
      gap: n(3), pointerEvents: 'none',
    },
    barRow: { display: 'flex', alignItems: 'center', gap: n(5) },
    miniRow: { display: 'flex', alignItems: 'center', gap: n(5) },
    barLabel: {
      fontFamily: 'monospace', fontSize: n(compact ? 7.5 : 8.5),
      color: '#6a5a3a', letterSpacing: 1.5, textShadow: etch,
      minWidth: n(compact ? 22 : 26), textAlign: 'right',
    },
    barTrack: {
      width: n(compact ? 44 : 62), height: n(3),
      background: 'rgba(20,16,9,0.6)', borderRadius: 2, overflow: 'hidden',
    },
    barFill: { height: '100%', borderRadius: 2, transition: 'width 0.15s linear' },
    barValue: {
      fontFamily: 'monospace', fontSize: n(compact ? 11 : 13),
      fontWeight: 'bold', textShadow: etch,
      minWidth: n(compact ? 20 : 24), textAlign: 'right',
    },
    configRow: {
      display: 'flex', gap: n(7), marginTop: n(1),
      fontFamily: 'monospace', fontSize: n(compact ? 8 : 9),
      letterSpacing: 1, textShadow: etch,
    },

    // ── The radio call ──────────────────────────────────────────────────
    radioStrip: {
      position: 'absolute',
      top: `calc(${n(10)}px + ${safeT})`,
      left: '50%', transform: 'translateX(-50%)',
      width: compact ? 'calc(100% - 20px)' : 'min(620px, 82%)',
      // A wash rather than a panel: dark enough to read on, transparent
      // enough that the aeroplane behind it is never hidden.
      background: 'linear-gradient(180deg, rgba(14,10,5,0.90) 0%, rgba(14,10,5,0.72) 100%)',
      borderLeft: '2px solid #ffd080',
      borderRadius: 3,
      padding: `${n(6)}px ${n(10)}px ${n(7)}px`,
      fontFamily: 'monospace',
      pointerEvents: 'auto',
      zIndex: 300,
      boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
    },
    radioHead: { display: 'flex', alignItems: 'center', gap: n(6) },
    radioLive: {
      width: n(5), height: n(5), borderRadius: '50%',
      background: '#ff4a3a', boxShadow: '0 0 6px #ff4a3a', flexShrink: 0,
      animation: 'aa-live 1.6s steps(1, end) infinite',
    },
    radioFrom: {
      fontSize: n(compact ? 10 : 11), letterSpacing: 2,
      color: '#ffd080', textTransform: 'uppercase', fontWeight: 'bold',
    },
    radioBody: {
      color: '#c8b888',
      fontSize: n(compact ? 10.5 : 12.5),
      lineHeight: 1.35,
      margin: `${n(3)}px 0 ${n(6)}px`,
    },
    radioChoices: { display: 'flex', flexWrap: 'wrap', gap: n(5) },
    radioChip: {
      display: 'flex', alignItems: 'center', gap: n(6),
      background: 'rgba(255,214,140,0.07)',
      border: '1px solid #5a4a20',
      borderRadius: 2,
      color: '#f0e2c4',
      fontFamily: 'monospace',
      fontSize: n(compact ? 10.5 : 12),
      textAlign: 'left',
      // Still a comfortable tap target even though it is now a chip
      minHeight: 38,
      padding: `${n(4)}px ${n(9)}px`,
      cursor: 'pointer',
      flex: compact ? '1 1 100%' : '0 1 auto',
    },
    radioChipKey: {
      flexShrink: 0,
      width: n(15), height: n(15),
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: '1px solid #6b5624', borderRadius: 2,
      color: '#ffd080', fontSize: n(9),
    },
    radioChipText: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
    radioChipCost: { fontSize: n(9), color: '#8a7a5a', lineHeight: 1.3 },
  };
}
