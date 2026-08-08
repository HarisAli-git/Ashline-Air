/**
 * Regional terrain. Each settlement sits in its own country, and a flight
 * between two of them crosses continuously from one into the other — the
 * palette, the shape of the land, the vegetation and the ground clutter all
 * blend across the route rather than switching at a line.
 */

export type BiomeId = 'basin' | 'redrock' | 'industrial' | 'ashland';

export interface BiomePalette {
  skyTop: number; skyBot: number; glow: number;
  far: number;
  mountain: number; mountainDark: number; snow: number;
  hill: number; hillLight: number;
  scrub: number;
  groundTop: number; ground: number; groundLine: number; dash: number;
}

export interface BiomeShape {
  /** Height multiplier for the mountain range. */
  ridgeAmp: number;
  /** Height multiplier for the near hills. */
  hillAmp: number;
  /**
   * 0 = pointed peaks, 1 = hard flat-topped mesas. Terraces the silhouette,
   * which is what makes sandstone country read as sandstone.
   */
  plateau: number;
  /** 0–1 density of trees on the hill layer. */
  trees: number;
  /** Extra high-frequency roughness in the ridgeline. */
  roughness: number;
  /** Snow/pale caps on the high crests. */
  caps: number;
}

export interface Biome {
  palette: BiomePalette;
  shape: BiomeShape;
}

export const BIOMES: Record<BiomeId, Biome> = {
  // Dried river basin — pale bleached earth, low worn hills, little cover
  basin: {
    palette: {
      skyTop: 0x1d3352, skyBot: 0xd0a252, glow: 0xd89040,
      far: 0x353a3c,
      mountain: 0x4a4a44, mountainDark: 0x33342f, snow: 0xbfc2b4,
      hill: 0x5a5334, hillLight: 0x726a44,
      scrub: 0x332c18,
      groundTop: 0x6b5c38, ground: 0x4a3f26, groundLine: 0x8a7448, dash: 0xbca86a,
    },
    shape: { ridgeAmp: 0.75, hillAmp: 0.7, plateau: 0.25, trees: 0.15, roughness: 0.8, caps: 0.15 },
  },

  // Red sandstone — deep rust, towering flat-topped mesas and buttes
  redrock: {
    palette: {
      skyTop: 0x2a2440, skyBot: 0xe08a3a, glow: 0xf07828,
      far: 0x5a3020,
      mountain: 0x8a3c1e, mountainDark: 0x5c2412, snow: 0xd8a070,
      hill: 0x7a3a1c, hillLight: 0x9c5228,
      scrub: 0x46200e,
      groundTop: 0x8a4520, ground: 0x622f14, groundLine: 0xa85c28, dash: 0xd08a4a,
    },
    shape: { ridgeAmp: 1.25, hillAmp: 0.9, plateau: 0.85, trees: 0.05, roughness: 0.5, caps: 0.0 },
  },

  // Pre-war rail depot — slate, slag heaps, sharp industrial spoil
  industrial: {
    palette: {
      skyTop: 0x232a34, skyBot: 0x8e8272, glow: 0x9a8058,
      far: 0x2a3038,
      mountain: 0x3c434c, mountainDark: 0x272c33, snow: 0x9aa4ae,
      hill: 0x3e4038, hillLight: 0x4e5244,
      scrub: 0x24261f,
      groundTop: 0x4a4a44, ground: 0x33342e, groundLine: 0x6a6a60, dash: 0x9a9a86,
    },
    shape: { ridgeAmp: 0.9, hillAmp: 1.0, plateau: 0.45, trees: 0.1, roughness: 1.3, caps: 0.1 },
  },

  // Burnt-over forest returning to green — the default in-between country
  ashland: {
    palette: {
      skyTop: 0x1a3050, skyBot: 0xc88830, glow: 0xd07820,
      far: 0x1c2836,
      mountain: 0x28384a, mountainDark: 0x1a2838, snow: 0xc8d8e8,
      hill: 0x304020, hillLight: 0x3a5028,
      scrub: 0x241a0c,
      groundTop: 0x362614, ground: 0x2a1e0e, groundLine: 0x6a4820, dash: 0xa89050,
    },
    shape: { ridgeAmp: 1.0, hillAmp: 1.0, plateau: 0.0, trees: 0.65, roughness: 1.0, caps: 0.7 },
  },
};

/** Settlements without an explicit biome fall back to the surrounding country. */
export function biomeFor(id: string | undefined): BiomeId {
  switch (id) {
    case 'ashford_basin':    return 'basin';
    case 'redrock_camp':     return 'redrock';
    case 'irongate_station': return 'industrial';
    default:                 return 'ashland';
  }
}

function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

/**
 * The country at a given point along the route. Rather than a straight A→B
 * fade, the middle of the trip passes through neutral wasteland, so you
 * genuinely leave one region before arriving in the next.
 */
export function blendBiome(from: BiomeId, to: BiomeId, progress: number): Biome {
  const p = Math.max(0, Math.min(1, progress));
  const a = BIOMES[from], b = BIOMES[to], mid = BIOMES.ashland;

  // Weight the two endpoints against the neutral middle
  const wMid = Math.sin(Math.PI * p) * 0.45;
  const wA = (1 - p) * (1 - wMid);
  const wB = p * (1 - wMid);
  const total = wA + wB + wMid || 1;

  const lerp3 = (ca: number, cb: number, cm: number): number => {
    // Blend A→B first, then pull toward the neutral middle
    const ab = mix(ca, cb, wB / Math.max(1e-6, wA + wB));
    return mix(ab, cm, wMid / total);
  };
  const num3 = (na: number, nb: number, nm: number): number =>
    ((na * wA + nb * wB + nm * wMid) / total);

  const palette = {} as BiomePalette;
  for (const k of Object.keys(a.palette) as Array<keyof BiomePalette>) {
    palette[k] = lerp3(a.palette[k], b.palette[k], mid.palette[k]);
  }

  const shape = {} as BiomeShape;
  for (const k of Object.keys(a.shape) as Array<keyof BiomeShape>) {
    shape[k] = num3(a.shape[k], b.shape[k], mid.shape[k]);
  }

  return { palette, shape };
}
