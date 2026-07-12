import Phaser from 'phaser';

/**
 * Camera-fade scene transition. Guards against double-triggering (e.g. a
 * button mashed during the fade) via a per-scene flag that Phaser clears
 * automatically when the scene restarts.
 */
export function fadeToScene(
  scene: Phaser.Scene,
  key: string,
  data?: object,
  durationMs = 300,
): void {
  const s = scene as Phaser.Scene & { __transitioning?: boolean };
  if (s.__transitioning) return;
  s.__transitioning = true;

  scene.cameras.main.fadeOut(durationMs, 0, 0, 0);
  scene.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
    s.__transitioning = false;
    scene.scene.start(key, data);
  });
}

/** White impact flash, then cut — for crash landings. */
export function flashToScene(
  scene: Phaser.Scene,
  key: string,
  data?: object,
): void {
  const s = scene as Phaser.Scene & { __transitioning?: boolean };
  if (s.__transitioning) return;
  s.__transitioning = true;

  scene.cameras.main.flash(180, 255, 255, 255);
  scene.cameras.main.once(Phaser.Cameras.Scene2D.Events.FLASH_COMPLETE, () => {
    scene.cameras.main.fadeOut(160, 20, 8, 4);
    scene.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      s.__transitioning = false;
      scene.scene.start(key, data);
    });
  });
}

/** Fade in on scene entry — call at the top of create(). */
export function fadeIn(scene: Phaser.Scene, durationMs = 280): void {
  scene.cameras.main.fadeIn(durationMs, 0, 0, 0);
}
