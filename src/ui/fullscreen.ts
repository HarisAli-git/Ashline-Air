/**
 * Real fullscreen, because `100dvh` is not enough on a phone.
 *
 * Mobile browsers keep the URL bar and the bottom toolbar over the page and
 * only collapse them when the *page* scrolls — which this game deliberately
 * never does. `dvh` tracks that chrome honestly, so the layout is correct, but
 * the game is still only ~85% of the glass. The Fullscreen API is the only
 * thing that actually reclaims it.
 *
 * It can only be requested from a user gesture, so this arms itself on the
 * first tap and disarms as soon as it succeeds.
 */

const isIOS = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function fullscreenSupported(): boolean {
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: unknown };
  return typeof el.requestFullscreen === 'function'
    || typeof el.webkitRequestFullscreen === 'function';
}

export function isFullscreen(): boolean {
  const d = document as Document & { webkitFullscreenElement?: Element };
  return Boolean(document.fullscreenElement ?? d.webkitFullscreenElement);
}

export async function requestFullscreen(): Promise<boolean> {
  const el = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
  };
  try {
    if (typeof el.requestFullscreen === 'function') await el.requestFullscreen({ navigationUI: 'hide' });
    else if (typeof el.webkitRequestFullscreen === 'function') await el.webkitRequestFullscreen();
    else return false;
  } catch {
    return false;
  }
  // Landscape lock is a bonus where it exists (Android/Chrome). iOS Safari has
  // neither this nor element fullscreen, which is why the prompt below still
  // has to exist as a fallback.
  const orientation = screen.orientation as ScreenOrientation & {
    lock?: (o: string) => Promise<void>;
  };
  try { await orientation?.lock?.('landscape'); } catch { /* not supported; fine */ }
  return true;
}

/**
 * Arm a one-shot: the next user gesture anywhere goes fullscreen.
 * Returns a disposer. Safe to call when unsupported — it simply never fires.
 */
export function armFullscreenOnGesture(onDone?: (ok: boolean) => void): () => void {
  if (!fullscreenSupported() || isFullscreen()) {
    onDone?.(isFullscreen());
    return () => {};
  }
  let disposed = false;
  const handler = async (): Promise<void> => {
    if (disposed) return;
    const ok = await requestFullscreen();
    if (ok) { dispose(); onDone?.(true); }
  };
  const dispose = (): void => {
    disposed = true;
    window.removeEventListener('pointerdown', handler);
    window.removeEventListener('keydown', handler);
  };
  window.addEventListener('pointerdown', handler);
  window.addEventListener('keydown', handler);
  return dispose;
}

/** iOS Safari has no element fullscreen — the user has to be told. */
export function needsManualFullscreenHint(): boolean {
  return isIOS() && !fullscreenSupported();
}
