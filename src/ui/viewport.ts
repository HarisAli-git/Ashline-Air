import { useEffect, useState } from 'react';
import { COMPACT_MAX_H, COMPACT_MAX_W, DESIGN_W_REF, MIN_LANDSCAPE_ASPECT } from '../game/GameSize';

/**
 * Where the game canvas actually is, and how big to draw UI on top of it.
 *
 * The React overlay is NOT inside the Phaser canvas, so it does not get the
 * Scale Manager's transform for free. It has to be told the canvas's on-screen
 * rectangle, or the HUD floats over the letterbox instead of over the game.
 *
 * `uiScale` is deliberately NOT the canvas scale. Scaling the HUD by the same
 * factor as the game would make 11 px labels 7 px on a phone and 21 px on a
 * 4K monitor — the game should get bigger on a big screen, the text should
 * barely move. The exponent damps it: ×1.9 of canvas becomes ×1.34 of UI.
 */
export interface ViewportInfo {
  vw: number;
  vh: number;
  /** Canvas rect in CSS pixels, relative to the viewport. */
  canvas: { left: number; top: number; width: number; height: number };
  /** Coarse pointer — show on-screen flight controls. */
  isTouch: boolean;
  /** Small screen — use the compact HUD, not a shrunken desktop one. */
  isCompact: boolean;
  /** Too upright to fly in; the player is asked to rotate. */
  isPortrait: boolean;
  /** Multiplier for UI sizing; 1 at the authored 1000 px canvas width. */
  uiScale: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function detectTouch(): boolean {
  if (typeof window === 'undefined') return false;
  // `pointer: coarse` is the honest question — "is the primary pointer a
  // finger" — rather than "does this device have a touchscreen", which is true
  // of plenty of laptops that should keep the desktop HUD.
  return window.matchMedia('(pointer: coarse)').matches
    || (navigator.maxTouchPoints > 0 && window.matchMedia('(hover: none)').matches);
}

function measure(canvas: HTMLCanvasElement | null): ViewportInfo {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const r = canvas?.getBoundingClientRect();
  const rect = r && r.width > 0
    ? { left: r.left, top: r.top, width: r.width, height: r.height }
    : { left: 0, top: 0, width: vw, height: vh };
  return {
    vw,
    vh,
    canvas: rect,
    isTouch: detectTouch(),
    isCompact: rect.height < COMPACT_MAX_H || Math.min(vw, rect.width) < COMPACT_MAX_W,
    isPortrait: vh > 0 && vw / vh < MIN_LANDSCAPE_ASPECT,
    uiScale: clamp(Math.pow(rect.width / DESIGN_W_REF, 0.45), 0.85, 1.45),
  };
}

// One shared measurement: every consumer sees the same numbers in the same
// frame, and the DOM is read once per resize instead of once per component.
let current: ViewportInfo = {
  vw: 1000, vh: 600,
  canvas: { left: 0, top: 0, width: 1000, height: 600 },
  isTouch: false, isCompact: false, isPortrait: false, uiScale: 1,
};
let canvasEl: HTMLCanvasElement | null = null;
const listeners = new Set<(v: ViewportInfo) => void>();

function publish(): void {
  const next = measure(canvasEl);
  const a = current, b = next;
  const same = a.vw === b.vw && a.vh === b.vh
    && a.canvas.left === b.canvas.left && a.canvas.top === b.canvas.top
    && a.canvas.width === b.canvas.width && a.canvas.height === b.canvas.height
    && a.isTouch === b.isTouch && a.isCompact === b.isCompact
    && a.isPortrait === b.isPortrait && a.uiScale === b.uiScale;
  if (same) return;
  current = next;
  listeners.forEach(fn => fn(next));
}

let raf = 0;
/** Re-measure on the next frame; coalesces bursts of resize events. */
export function refreshViewport(): void {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; publish(); });
}

/** Called once by App when Phaser has produced its canvas. */
export function bindViewportCanvas(el: HTMLCanvasElement | null): void {
  canvasEl = el;
  refreshViewport();
}

export function getViewport(): ViewportInfo { return current; }

let wired = false;
function wire(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  window.addEventListener('resize', refreshViewport);
  window.addEventListener('orientationchange', refreshViewport);
  // iOS fires resize BEFORE the new bar heights settle, so the first
  // measurement after a rotation is stale — take a second one shortly after.
  window.addEventListener('orientationchange', () => {
    setTimeout(refreshViewport, 300);
  });
  window.visualViewport?.addEventListener('resize', refreshViewport);
}

export function useViewport(): ViewportInfo {
  const [v, setV] = useState<ViewportInfo>(current);
  useEffect(() => {
    wire();
    listeners.add(setV);
    refreshViewport();
    setV(current);
    return () => { listeners.delete(setV); };
  }, []);
  return v;
}

/** `px(12)` → a UI-scaled pixel string. Keeps call sites readable. */
export function px(n: number, uiScale: number): string {
  return `${Math.round(n * uiScale * 100) / 100}px`;
}
