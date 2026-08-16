/**
 * The game's design resolution — the single source of truth for how big the
 * world is, in game units, before the Scale Manager fits it to the screen.
 *
 * Phaser runs in FIT mode, so the game is drawn at this size and then uniformly
 * scaled to the display. That is deliberate: the art and the flight model are
 * authored at a fixed scale, so RESIZE mode (canvas = viewport, 1 unit = 1 CSS
 * pixel) would make the aircraft fill a phone screen and shrink to a speck on a
 * 4K monitor. FIT keeps the framing identical everywhere.
 *
 * The HEIGHT is therefore FIXED. Every vertical constant in the game is
 * authored against it — `GROUND_Y_OFFSET`, `PLANE_MIN_Y`, `ALT_BAND`, the
 * two-band altitude camera, cloud deck altitudes — and changing it would
 * silently rescale the whole relationship between the flight model and the
 * screen.
 *
 * The WIDTH follows the device's aspect ratio instead. That is what removes the
 * letterbox: a 21:9 monitor and a phone held sideways each get a canvas shaped
 * like their own screen. It is safe to vary because horizontal layout is all
 * derived at runtime (`cameras.main.width`, `ParallaxWorld.width`), so a wider
 * canvas shows MORE WORLD either side of the aircraft rather than stretching
 * anything.
 */

/** Fixed. See above — do not make this responsive. */
export const DESIGN_H = 600;

/** The width the game was originally authored at; the reference for UI scale. */
export const DESIGN_W_REF = 1000;

/**
 * Width bounds. The floor stops a squarish tablet from cropping the world to a
 * porthole; the ceiling stops an ultrawide from pulling the horizon so far out
 * that hazards enter frame kilometres before they matter.
 */
export const DESIGN_W_MIN = 900;
export const DESIGN_W_MAX = 1500;

export interface DesignSize { width: number; height: number }

/** The design canvas for a given viewport, in game units. */
export function designSizeFor(vw: number, vh: number): DesignSize {
  const aspect = vw > 0 && vh > 0 ? vw / vh : DESIGN_W_REF / DESIGN_H;
  const width = Math.round(
    Math.min(DESIGN_W_MAX, Math.max(DESIGN_W_MIN, DESIGN_H * aspect)),
  );
  return { width, height: DESIGN_H };
}

/**
 * Below this the phone is being held upright and a side-scrolling flight sim
 * has almost no usable width — the player is asked to rotate instead.
 */
export const MIN_LANDSCAPE_ASPECT = 1.15;

/**
 * When to switch the HUD to its compact layout.
 *
 * HEIGHT is the binding constraint, not width: a phone in landscape is 844×390
 * — wide enough to look roomy, but the instrument strip and the on-screen
 * controls are both competing for those 390 vertical pixels. Keying compact off
 * width alone left a landscape phone running the full desktop panel, which ate
 * a fifth of the screen and wrapped its own readouts onto two lines.
 */
export const COMPACT_MAX_H = 560;
export const COMPACT_MAX_W = 720;
