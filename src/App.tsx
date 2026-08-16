import React, { useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
import { BootScene }       from './game/scenes/BootScene';
import { MenuScene }       from './game/scenes/MenuScene';
import { IntroScene }      from './game/scenes/IntroScene';
import { MapScene }        from './game/scenes/MapScene';
import { PreFlightScene }  from './game/scenes/PreFlightScene';
import { FlightScene }     from './game/scenes/FlightScene';
import { PostFlightScene } from './game/scenes/PostFlightScene';
import { EventBus }        from './game/utils/EventBus';
import { SoundEngine }     from './game/audio/SoundEngine';
import { FlightHUD }       from './ui/components/hud/FlightHUD';
import { PreFlightOverlay }from './ui/components/screens/PreFlightOverlay';
import { HangarScreen }   from './ui/components/screens/HangarScreen';
import { ProfilesScreen } from './ui/components/screens/ProfilesScreen';
import { GlobalNotification } from './ui/components/menus/Notification';
import { TouchControls } from './ui/components/hud/TouchControls';
import { OrientationGate } from './ui/components/OrientationGate';
import { designSizeFor } from './game/GameSize';
import { attachResponsiveScale } from './game/utils/responsive';
import { bindViewportCanvas, refreshViewport, useViewport } from './ui/viewport';

type UILayer = 'none' | 'flight' | 'preflight';

interface PreflightState {
  settlementId: string;
}

export default function App(): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const [uiLayer, setUiLayer] = useState<UILayer>('none');
  const [hangarOpen, setHangarOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [preflightState, setPreflightState] = useState<PreflightState | null>(null);
  const vp = useViewport();

  // Browsers only allow audio after a user gesture — unlock on the first one
  useEffect(() => {
    const unlock = (): void => SoundEngine.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    // The design canvas is shaped like the device (see GameSize.ts) and then
    // FIT-scaled onto it: the art and the flight model are authored at a fixed
    // scale, so RESIZE mode would make the aircraft fill a phone screen and
    // shrink to a speck on a 4K monitor. FIT keeps the framing identical
    // everywhere; the aspect-matched design width is what removes the letterbox.
    const design = designSizeFor(window.innerWidth, window.innerHeight);
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      backgroundColor: '#1a1208',
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: design.width,
        height: design.height,
      },
      // Phones lie about devicePixelRatio on some browsers and a 3× backing
      // store on a 6-year-old handset costs more than it looks like it gains.
      render: { antialias: true, powerPreference: 'high-performance' },
      input: { activePointers: 3 },   // throttle + pitch + a toggle, at once
      scene: [BootScene, MenuScene, IntroScene, MapScene, PreFlightScene, FlightScene, PostFlightScene],
      physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } },
    });
    gameRef.current = game;

    // The React overlay is not inside the canvas, so it has to be told where
    // the canvas ended up — otherwise the HUD floats over the letterbox.
    game.events.once(Phaser.Core.Events.READY, () => bindViewportCanvas(game.canvas));

    // DEV-only handle for headless verification: clicking canvas coordinates
    // breaks the moment the design width changes, which is exactly what the
    // responsive work does, so tests drive the game through this instead.
    if (import.meta.env.DEV) {
      (window as unknown as { __ashline?: unknown }).__ashline = { game, EventBus };
    }
    const detachScale = attachResponsiveScale(game, () => refreshViewport());

    // Wire scene transitions to React UI layer
    const u1 = EventBus.on('scene:start-flight', () => setUiLayer('flight'));
    const u2 = EventBus.on('scene:return-to-map', () => { setUiLayer('none'); setPreflightState(null); });
    const u3 = EventBus.on('scene:flight-complete', () => setUiLayer('none'));
    const u4 = EventBus.on('scene:open-preflight', ({ settlementId }) => {
      setPreflightState({ settlementId });
      setUiLayer('preflight');
    });
    // The hangar is its own overlay: it can be opened over the map or the
    // pre-flight board without tearing either of them down.
    const u5 = EventBus.on('ui:open-hangar', () => setHangarOpen(true));
    const u6 = EventBus.on('ui:close-hangar', () => setHangarOpen(false));
    const u7 = EventBus.on('ui:open-profiles', () => setProfilesOpen(true));
    const u8 = EventBus.on('ui:close-profiles', () => setProfilesOpen(false));

    return () => {
      u1(); u2(); u3(); u4(); u5(); u6(); u7(); u8();
      detachScale();
      bindViewportCanvas(null);
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, []);

  // The overlay is pinned to the canvas's real on-screen rectangle rather than
  // to the window, so it stays registered with the game even when FIT leaves a
  // letterbox band (a squarish tablet, or a window dragged to an odd shape).
  const overlayStyle: React.CSSProperties = {
    position: 'absolute',
    left: vp.canvas.left,
    top: vp.canvas.top,
    width: vp.canvas.width,
    height: vp.canvas.height,
    // Transparent to the pointer by default; each overlay opts back in, so a
    // mounted HUD never swallows a click meant for the game underneath.
    pointerEvents: 'none',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0d0a04', overflow: 'hidden' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {/* React UI overlays — rendered above the Phaser canvas */}
      <div style={overlayStyle}>
        {uiLayer === 'flight' && <FlightHUD />}
        {uiLayer === 'preflight' && preflightState && (
          <PreFlightOverlay settlementId={preflightState.settlementId} />
        )}

        {hangarOpen && <HangarScreen />}
        {profilesOpen && <ProfilesScreen />}

        {/* On-screen flight controls, touch devices only */}
        {uiLayer === 'flight' && <TouchControls />}

        {/* Global notification always available */}
        <GlobalNotification />
      </div>

      {/* A side-scrolling flight sim has no usable width held upright */}
      <OrientationGate />
    </div>
  );
}
