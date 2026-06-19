import React, { useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
import { BootScene }       from './game/scenes/BootScene';
import { MenuScene }       from './game/scenes/MenuScene';
import { MapScene }        from './game/scenes/MapScene';
import { PreFlightScene }  from './game/scenes/PreFlightScene';
import { FlightScene }     from './game/scenes/FlightScene';
import { PostFlightScene } from './game/scenes/PostFlightScene';
import { EventBus }        from './game/utils/EventBus';
import { FlightHUD }       from './ui/components/hud/FlightHUD';
import { PreFlightOverlay }from './ui/components/screens/PreFlightOverlay';
import { GlobalNotification } from './ui/components/menus/Notification';

type UILayer = 'none' | 'flight' | 'preflight';

interface PreflightState {
  settlementId: string;
}

export default function App(): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const [uiLayer, setUiLayer] = useState<UILayer>('none');
  const [preflightState, setPreflightState] = useState<PreflightState | null>(null);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    gameRef.current = new Phaser.Game({
      type: Phaser.AUTO,
      width: 1000,
      height: 600,
      parent: containerRef.current,
      backgroundColor: '#1a1208',
      scene: [BootScene, MenuScene, MapScene, PreFlightScene, FlightScene, PostFlightScene],
      physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } },
    });

    // Wire scene transitions to React UI layer
    const u1 = EventBus.on('scene:start-flight', () => setUiLayer('flight'));
    const u2 = EventBus.on('scene:return-to-map', () => { setUiLayer('none'); setPreflightState(null); });
    const u3 = EventBus.on('scene:flight-complete', () => setUiLayer('none'));
    const u4 = EventBus.on('scene:open-preflight', ({ settlementId }) => {
      setPreflightState({ settlementId });
      setUiLayer('preflight');
    });

    return () => {
      u1(); u2(); u3(); u4();
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, []);

  return (
    <div style={{ position: 'relative', width: 1000, height: 600, margin: '0 auto' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* React UI overlays — rendered above the Phaser canvas */}
      {uiLayer === 'flight' && <FlightHUD />}
      {uiLayer === 'preflight' && preflightState && (
        <PreFlightOverlay settlementId={preflightState.settlementId} />
      )}

      {/* Global notification always available */}
      <GlobalNotification />
    </div>
  );
}
