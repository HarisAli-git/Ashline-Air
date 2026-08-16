import Phaser from 'phaser';
import { designSizeFor } from '../GameSize';

/**
 * A scene that can re-lay-out in place instead of being torn down.
 *
 * FlightScene MUST implement this: restarting it mid-flight would throw away
 * the flight. Scenes that rebuild cheaply from the save (menu, map, pre/post
 * flight) are simply restarted, which is the same path MapScene already uses
 * to refresh itself after the hangar closes.
 */
export interface RelayoutScene extends Phaser.Scene {
  relayout(width: number, height: number): void;
}

function canRelayout(s: Phaser.Scene): s is RelayoutScene {
  return typeof (s as Partial<RelayoutScene>).relayout === 'function';
}

/** Scenes that must not be restarted just because the window changed shape. */
const NEVER_RESTART = new Set(['IntroScene', 'BootScene']);

/** How much the design width must move before it is worth a re-layout. */
const WIDTH_EPSILON = 12;

/**
 * Keeps the design canvas shaped like the device it is being played on.
 *
 * FIT mode already handles a plain resize for free — the canvas just scales.
 * This only steps in when the ASPECT changes (a phone rotating, a window
 * dragged to a different shape), where scaling alone would start letterboxing:
 * it re-derives the design width, tells the Scale Manager, and gives every
 * running scene a chance to re-lay-out at the new width.
 */
export function attachResponsiveScale(
  game: Phaser.Game,
  onApplied?: (w: number, h: number) => void,
): () => void {
  let timer = 0;

  const apply = (): void => {
    if (!game.scale) return;
    const next = designSizeFor(window.innerWidth, window.innerHeight);
    const cur = game.scale.gameSize;
    const changed = Math.abs(next.width - cur.width) >= WIDTH_EPSILON
      || Math.abs(next.height - cur.height) >= WIDTH_EPSILON;

    if (changed) {
      game.scale.setGameSize(next.width, next.height);
      for (const scene of game.scene.getScenes(true)) {
        const key = scene.scene.key;
        if (NEVER_RESTART.has(key)) continue;
        if (canRelayout(scene)) scene.relayout(next.width, next.height);
        else scene.scene.restart();
      }
    }
    // Even a pure rescale moves the canvas on screen, so the React overlay
    // still has to be told where it went.
    onApplied?.(game.scale.gameSize.width, game.scale.gameSize.height);
  };

  const schedule = (): void => {
    window.clearTimeout(timer);
    // Debounced: a desktop resize drag fires continuously, and each apply()
    // may restart scenes. Mobile rotation also settles over a few hundred ms.
    timer = window.setTimeout(apply, 180);
  };

  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  game.scale.on(Phaser.Scale.Events.RESIZE, () => onApplied?.(
    game.scale.gameSize.width, game.scale.gameSize.height,
  ));

  apply();

  return () => {
    window.clearTimeout(timer);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
  };
}
