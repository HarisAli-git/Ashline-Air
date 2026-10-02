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
  uiScale: number, compact: boolean, touch = false,
  /** A flight-school step is docked at the top (phones) — push the chips under it. */
  lessonOnTop = false,
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
      top: `calc(${n(compact ? 14 : 18) + (lessonOnTop ? n(84) : 0)}px + ${safeT})`,
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

    // ── Drop card: the next site, top-left ──────────────────────────────
    /*
     * Top-left because it is the only corner nothing else lives in: the
     * cautions own the top centre, the systems drawer the top right, and the
     * two clusters the bottom corners. Pushed down past the time-warp tag,
     * which Phaser draws at the very top-left.
     */
    dropCard: {
      position: 'absolute',
      top: `calc(${n(compact ? 38 : 48)}px + ${safeT})`,
      left: `calc(${n(10) + leverClearance}px + ${safeL})`,
      background: 'linear-gradient(90deg, rgba(10,14,8,0.62) 0%, rgba(10,14,8,0.0) 100%)',
      borderLeft: '2px solid #9fe8b0',
      padding: `${n(compact ? 3 : 5)}px ${n(compact ? 10 : 16)}px ${n(compact ? 3 : 5)}px ${n(7)}px`,
      fontFamily: 'monospace',
      textShadow: etch,
      pointerEvents: 'none',
      maxWidth: compact ? '46%' : 'min(360px, 40%)',
      zIndex: 120,
    },
    dropHead: {
      display: 'flex', alignItems: 'center', gap: n(6), flexWrap: 'wrap',
      fontSize: n(compact ? 8.5 : 9.5), letterSpacing: 1.5, color: '#9fe8b0',
      textTransform: 'uppercase', fontWeight: 'bold',
    },
    dropBadge: {
      fontSize: n(compact ? 7.5 : 8.5), letterSpacing: 1, color: '#ff8844',
      border: '1px solid #ff8844', borderRadius: 2, padding: `0 ${n(3)}px`,
    },
    dropRow: { display: 'flex', alignItems: 'baseline', gap: n(8), marginTop: n(1) },
    dropKm: {
      fontSize: n(compact ? 15 : 19), fontWeight: 'bold', color: '#e8d5b7', letterSpacing: -0.5,
    },
    dropPips: { display: 'flex', gap: n(2), alignItems: 'center' },
    dropNeed: {
      fontSize: n(compact ? 9 : 10.5), fontWeight: 'bold', letterSpacing: 1, color: '#ffd080',
      whiteSpace: 'nowrap',
    },
    dropAboard: { fontWeight: 'normal', color: '#8a7a5a' },
    dropPip: { width: n(compact ? 6 : 7), height: n(compact ? 6 : 7), borderRadius: 1 },
    meterWrap: { display: 'flex', alignItems: 'center', gap: n(6), marginTop: n(compact ? 3 : 5) },
    meterTrack: {
      position: 'relative', width: n(compact ? 120 : 170), height: n(compact ? 7 : 9),
      background: 'rgba(20,16,9,0.7)', border: '1px solid rgba(159,232,176,0.35)', borderRadius: 2,
    },
    meterWindow: { position: 'absolute', top: 0, bottom: 0, background: 'rgba(159,232,176,0.35)' },
    meterAim: { position: 'absolute', top: -3, bottom: -3, width: 2, marginLeft: -1, background: '#e8d5b7' },
    meterMark: {
      position: 'absolute', top: '50%', width: n(compact ? 7 : 9), height: n(compact ? 7 : 9),
      marginLeft: -n(compact ? 3.5 : 4.5), marginTop: -n(compact ? 3.5 : 4.5), borderRadius: '50%',
      transition: 'left 0.08s linear',
    },
    meterRead: { fontSize: n(compact ? 9.5 : 11), fontWeight: 'bold', minWidth: n(30) },
    dropCue: {
      fontSize: n(compact ? 9.5 : 11.5), fontWeight: 'bold', letterSpacing: 1,
      marginTop: n(compact ? 1 : 2), whiteSpace: 'nowrap',
    },

    // ── Teaching line, first flight only ────────────────────────────────
    tutorial: {
      position: 'absolute',
      /*
       * Above the toast band, not under it.
       *
       * Both live at the bottom centre — the toast because the HUD redesign
       * freed that corner, and this because it replaces the keyboard legend.
       * The persistent line sits higher and the transient one passes beneath
       * it, so they stack instead of crowding each other.
       */
      // The toast is ~46 px tall on desktop and sits 40 px up, so it spans
      // 40-86. The first value put this line at 62 — inside it — and the
      // screenshot showed the instruction hidden behind "Cargo aboard".
      bottom: `calc(${n(compact ? 68 : 96)}px + ${safeB})`,
      // Right of the aircraft, which sits on the runway at the left third
      left: '40%',
      maxWidth: compact ? (touch ? '45%' : '56%') : 'min(620px, 56%)',
      textAlign: 'left',
      // A wash rather than a panel — it sits ON the world like the rest of it
      background: 'rgba(12,9,4,0.78)',
      borderLeft: '2px solid #ffd080',
      padding: `${n(compact ? 6 : 9)}px ${n(14)}px ${n(compact ? 4 : 6)}px`,
      borderRadius: 3,
      fontFamily: 'monospace',
      fontSize: n(compact ? 10.5 : 13),
      lineHeight: 1.35,
      color: '#ffd080',
      textShadow: etch,
      pointerEvents: 'none',
      zIndex: 260,
    },
  };
}
