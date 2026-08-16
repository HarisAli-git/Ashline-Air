/**
 * `pointer: coarse` is the honest question — "is the primary pointer a finger?"
 * — rather than "does this device have a touchscreen", which is also true of a
 * great many laptops that should keep the desktop controls and HUD.
 */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches
    || (navigator.maxTouchPoints > 0 && window.matchMedia('(hover: none)').matches);
}
