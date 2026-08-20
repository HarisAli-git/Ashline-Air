import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TouchInput, type HeldControl, type PulseControl } from '../../../game/utils/touchInput';
import { useFlightState, useGearFlaps, useFlightStatus } from '../../store/gameStore';
import { useViewport } from '../../viewport';
import { hudPanelHeight } from './hudStyles';

/**
 * On-screen flight controls.
 *
 * Shape follows the real cockpit, because that is what makes it learnable
 * without a legend: the throttle is a LEVER on the left that you drag and that
 * stays where you left it, and pitch is a two-way stick on the right that
 * springs back when you let go. Buttons for a continuous throttle would mean
 * holding a finger down for the whole climb.
 *
 * Everything is pointer-events based (not touch/mouse events) so a stylus, a
 * trackpad and a finger all work, and every control releases on `pointercancel`
 * — without that, a control that loses capture mid-gesture stays stuck down and
 * the aircraft flies away at full deflection.
 */

/**
 * The controls were as heavy as the panel they sat next to.
 *
 * Once the instrument slab came off, the throttle lever became the biggest
 * opaque object on a phone screen — a solid block down 45% of the display.
 * These now follow the same rule as the rest of the HUD: hug the edge, stay
 * translucent, and let the aeroplane show through. A control has to be big
 * enough for a thumb, not big enough to fly the game from behind.
 */
const HOLD_BG = 'rgba(16,13,7,0.42)';
const HOLD_BG_ON = 'rgba(255,208,128,0.26)';
const EDGE = 'rgba(160,138,80,0.55)';

export function TouchControls(): React.ReactElement | null {
  const vp = useViewport();
  const state = useFlightState();
  const { gearDown, flapsDeployed } = useGearFlaps();
  const status = useFlightStatus();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Any held control must be dropped if the component goes away mid-press
  useEffect(() => () => TouchInput.reset(), []);

  if (!vp.isTouch || !state) return null;

  const s = vp.uiScale;
  const pad = (n: number): number => Math.round(n * s);
  // Sit ABOVE the instrument strip. Offsetting by a guessed constant buried the
  // throttle lever and the lower half of the pitch stick under the panel on a
  // short screen — the panel's real height is the only safe datum.
  const deck = hudPanelHeight(s, vp.isCompact) + pad(8);
  // The lever has to fit between the panel and the top of the screen, with the
  // annunciator stack left clear, so its length is budgeted from the viewport
  // rather than fixed.
  // Budgeted as a FRACTION of the screen rather than a fixed pixel length, so
  // it can never take the display over the way the old 190 px lever did.
  /*
   * Which systems are worth a permanent button right now.
   *
   * 130 m rather than "on the ground": the gear and the flaps matter through
   * the whole of a departure and the whole of an approach, not just while the
   * wheels are touching.
   */
  const nearGround = state.altitude < 130;
  const engineOut = status?.engineFailed === true || state.enginePower < 0.02;

  const leverH = Math.max(84, Math.min(Math.round(vp.canvas.height * 0.34), Math.round(150 * s)));
  const stickSize = Math.max(48, Math.min(Math.round(62 * s), Math.round((vp.canvas.height - deck - pad(70)) / 2)));

  return (
    <>
      <ThrottleLever scale={s} throttle={state.throttle} height={leverH} deck={deck} />
      <PitchStick scale={s} size={stickSize} deck={deck} />

      {/*
        * ── Systems: what you need NOW, not everything you might ever need ──
        *
        * All six controls used to live behind a drawer, so lowering the gear on
        * final meant taking a thumb off the stick, opening a menu, hunting a
        * button and closing it again — on approach, which is the one moment
        * you cannot spare the attention.
        *
        * A bigger grid is not the answer either; a phone has no room for six
        * permanent buttons that will not foul the flying thumb. But these
        * controls are CONTEXTUAL: gear and flaps only matter near the ground,
        * time warp only in the cruise, and the starter only when the engine is
        * off. Showing the two or three that apply right now gets each of them
        * to one tap, and leaves the drawer for the things you touch once a
        * flight if at all.
        */}
      <div
        style={{
          position: 'absolute',
          right: `calc(${pad(12)}px + env(safe-area-inset-right, 0px))`,
          top: pad(52),
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: pad(6),
          pointerEvents: 'auto',
        }}
      >
        {/* The engine being out overrides everything — nothing else matters */}
        {engineOut && (
          <PulseButton label="▶ START" scale={s} control="engine" wide danger />
        )}

        {/* Near the ground: the two things a takeoff or an approach needs */}
        {!engineOut && nearGround && (
          <>
            <PulseButton label={gearDown ? 'GEAR ▼' : 'GEAR ▲'} scale={s} control="gear" wide />
            <PulseButton label={flapsDeployed ? 'FLAP ▼' : 'FLAP ▲'} scale={s} control="flaps" wide />
          </>
        )}

        {/* Settled in the cruise: the only control worth a permanent slot */}
        {!engineOut && !nearGround && (
          <PulseButton label="TIME ⏩" scale={s} control="time" wide />
        )}

        <PulseButton
          label={drawerOpen ? '✕' : '☰'}
          scale={s}
          onPress={() => setDrawerOpen(o => !o)}
        />
        {drawerOpen && (
          <>
            {/* Everything, always — the contextual set is a shortcut, not a cage */}
            <PulseButton label={gearDown ? 'GEAR ▼' : 'GEAR ▲'} scale={s} control="gear" wide />
            <PulseButton label={flapsDeployed ? 'FLAP ▼' : 'FLAP ▲'} scale={s} control="flaps" wide />
            <PulseButton label="ENGINE" scale={s} control="engine" wide />
            <PulseButton label="TIME ⏩" scale={s} control="time" wide />
            <PulseButton label="MUTE" scale={s} control="mute" wide />
            <PulseButton label="ABORT" scale={s} control="abort" wide danger />
          </>
        )}
      </div>
    </>
  );
}

/**
 * A draggable throttle lever. It reports an ABSOLUTE demand, which FlightScene
 * turns back into up/down — so the lever moves instantly but the engine still
 * spools at its own rate.
 */
function ThrottleLever({ scale, throttle, height, deck }: {
  scale: number; throttle: number; height: number; deck: number;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const w = Math.round(34 * scale);
  const h = height;

  const setFromEvent = useCallback((clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Top of the track is full power, which is the way a real quadrant reads.
    const t = 1 - (clientY - r.top) / r.height;
    TouchInput.setThrottleTarget(Math.min(1, Math.max(0, t)));
  }, []);

  return (
    <div
      ref={ref}
      onPointerDown={e => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        setFromEvent(e.clientY);
      }}
      onPointerMove={e => { if (e.buttons || e.pointerType === 'touch') setFromEvent(e.clientY); }}
      // The lever HOLDS its setting on release — that is the point of a lever.
      onPointerCancel={() => { /* keep the setting */ }}
      style={{
        position: 'absolute',
        left: `calc(${Math.round(4 * scale)}px + env(safe-area-inset-left, 0px))`,
        bottom: `calc(${deck}px + env(safe-area-inset-bottom, 0px))`,
        width: w,
        height: h,
        background: HOLD_BG,
        border: `1px solid ${EDGE}`,
        borderRadius: Math.round(10 * scale),
        touchAction: 'none',
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        overflow: 'hidden',
      }}
    >
      <div style={{
        height: `${throttle * 100}%`,
        background: 'linear-gradient(180deg, #ffd080 0%, #8a6a20 100%)',
        opacity: 0.30,
      }} />
      {/* Knob at the current setting */}
      <div style={{
        position: 'absolute',
        left: 3, right: 3,
        bottom: `calc(${throttle * 100}% - ${Math.round(7 * scale)}px)`,
        height: Math.round(14 * scale),
        background: '#e8d5b7',
        borderRadius: Math.round(4 * scale),
        boxShadow: '0 1px 3px rgba(0,0,0,0.6)',
      }} />
      <div style={{
        position: 'absolute', top: Math.round(5 * scale), left: 0, right: 0,
        textAlign: 'center', color: '#e8d5b7',
        fontFamily: 'monospace', fontSize: Math.round(11 * scale), fontWeight: 700,
        textShadow: '0 1px 2px #000',
      }}>
        {Math.round(throttle * 100)}%
      </div>
      <div style={{
        position: 'absolute', bottom: Math.round(4 * scale), left: 0, right: 0,
        textAlign: 'center', color: '#8a7a5a',
        fontFamily: 'monospace', fontSize: Math.round(9 * scale),
      }}>
        THR
      </div>
    </div>
  );
}

/** Two-way pitch control that springs back to neutral on release. */
function PitchStick({ scale, size, deck }: {
  scale: number; size: number; deck: number;
}): React.ReactElement {
  return (
    <div style={{
      position: 'absolute',
      right: `calc(${Math.round(4 * scale)}px + env(safe-area-inset-right, 0px))`,
      bottom: `calc(${deck}px + env(safe-area-inset-bottom, 0px))`,
      display: 'flex',
      flexDirection: 'column',
      gap: Math.round(5 * scale),
      pointerEvents: 'auto',
    }}>
      <HoldButton control="pitchUp" label="▲" size={size} scale={scale} hint="NOSE UP" />
      <HoldButton control="pitchDown" label="▼" size={size} scale={scale} hint="NOSE DN" />
    </div>
  );
}

function HoldButton({
  control, label, size, scale, hint,
}: {
  control: HeldControl; label: string; size: number; scale: number; hint: string;
}): React.ReactElement {
  const [down, setDown] = useState(false);
  const press = (on: boolean): void => { setDown(on); TouchInput.setHeld(control, on); };

  return (
    <button
      onPointerDown={e => {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        press(true);
      }}
      onPointerUp={() => press(false)}
      // Losing capture mid-gesture must release the control, or the aeroplane
      // flies off at full deflection with nothing on screen holding it there.
      onPointerCancel={() => press(false)}
      onPointerLeave={() => press(false)}
      onContextMenu={e => e.preventDefault()}
      style={{
        width: size,
        height: size,
        background: down ? HOLD_BG_ON : HOLD_BG,
        border: `1px solid ${down ? '#ffd080' : EDGE}`,
        backdropFilter: 'blur(1px)',
        borderRadius: Math.round(12 * scale),
        color: '#e8d5b7',
        fontSize: Math.round(24 * scale),
        lineHeight: 1,
        touchAction: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: Math.round(2 * scale),
      }}
      aria-label={hint}
    >
      <span>{label}</span>
      <span style={{ fontSize: Math.round(8 * scale), fontFamily: 'monospace', color: '#8a7a5a' }}>
        {hint}
      </span>
    </button>
  );
}

function PulseButton({
  label, scale, control, onPress, wide, danger,
}: {
  label: string; scale: number;
  control?: PulseControl; onPress?: () => void;
  wide?: boolean; danger?: boolean;
}): React.ReactElement {
  return (
    <button
      onPointerDown={e => {
        e.preventDefault();
        if (control) TouchInput.pulse(control);
        onPress?.();
      }}
      onContextMenu={e => e.preventDefault()}
      style={{
        minWidth: wide ? Math.round(92 * scale) : Math.round(42 * scale),
        height: Math.round(38 * scale),
        padding: `0 ${Math.round(10 * scale)}px`,
        background: HOLD_BG,
        border: `1px solid ${danger ? '#a04030' : EDGE}`,
        borderRadius: Math.round(8 * scale),
        color: danger ? '#ff9080' : '#e8d5b7',
        fontFamily: 'monospace',
        fontSize: Math.round(12 * scale),
        letterSpacing: 0.5,
        touchAction: 'none',
      }}
    >
      {label}
    </button>
  );
}
