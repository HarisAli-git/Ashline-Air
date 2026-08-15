import { EventBus } from '../game/utils/EventBus';

/**
 * Pilots.
 *
 * Front-end only — there is no account, no server and no password. A "pilot"
 * is a named save slot held in localStorage, so several people can share a
 * browser without standing on each other's progress, and one person can keep
 * a clean run alongside an experimental one.
 *
 * Every save key is namespaced by the active pilot's id, which is the whole
 * mechanism: SaveService writes to `ashline_air_save__<id>` and knows nothing
 * else about profiles.
 */

const INDEX_KEY = 'ashline_air_pilots';
const ACTIVE_KEY = 'ashline_air_active_pilot';

export interface Pilot {
  id: string;
  name: string;
  createdAt: number;
  lastPlayed: number;
}

function readIndex(): Pilot[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIndex(list: Pilot[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(list));
}

class ProfileServiceClass {
  /** All pilots, most recently played first. */
  list(): Pilot[] {
    return readIndex().sort((a, b) => b.lastPlayed - a.lastPlayed);
  }

  get activeId(): string | null {
    return localStorage.getItem(ACTIVE_KEY);
  }

  active(): Pilot | null {
    const id = this.activeId;
    return id ? readIndex().find(p => p.id === id) ?? null : null;
  }

  /** The localStorage key this pilot's save lives under. */
  saveKeyFor(id: string | null): string {
    return id ? `ashline_air_save__${id}` : 'ashline_air_save';
  }

  create(name: string): Pilot {
    const clean = name.trim().slice(0, 20) || 'Pilot';
    const pilot: Pilot = {
      id: `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
      name: clean,
      createdAt: Date.now(),
      lastPlayed: Date.now(),
    };
    writeIndex([...readIndex(), pilot]);
    return pilot;
  }

  select(id: string): boolean {
    const pilot = readIndex().find(p => p.id === id);
    if (!pilot) return false;
    pilot.lastPlayed = Date.now();
    writeIndex(readIndex().map(p => (p.id === id ? pilot : p)));
    localStorage.setItem(ACTIVE_KEY, id);
    EventBus.emit('profile:changed', { id, name: pilot.name });
    return true;
  }

  /** Remove a pilot and everything they had flown. */
  remove(id: string): void {
    writeIndex(readIndex().filter(p => p.id !== id));
    localStorage.removeItem(this.saveKeyFor(id));
    if (this.activeId === id) localStorage.removeItem(ACTIVE_KEY);
  }

  rename(id: string, name: string): void {
    const clean = name.trim().slice(0, 20);
    if (!clean) return;
    writeIndex(readIndex().map(p => (p.id === id ? { ...p, name: clean } : p)));
  }

  /**
   * Guarantee there is somebody to fly as. Called before the first save read,
   * so a fresh browser lands straight in the game instead of on a form, and
   * an existing single-slot save is adopted rather than orphaned.
   */
  ensureActive(): Pilot {
    const existing = this.active();
    if (existing) return existing;

    const list = readIndex();
    if (list.length > 0) {
      const first = list.sort((a, b) => b.lastPlayed - a.lastPlayed)[0];
      this.select(first.id);
      return first;
    }

    const pilot = this.create('Pilot One');
    // Adopt a pre-profiles save so nobody loses a run to this feature landing
    const legacy = localStorage.getItem('ashline_air_save');
    if (legacy) localStorage.setItem(this.saveKeyFor(pilot.id), legacy);
    this.select(pilot.id);
    return pilot;
  }
}

export const ProfileService = new ProfileServiceClass();
