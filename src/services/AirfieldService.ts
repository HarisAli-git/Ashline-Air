import type { AircraftDefinition, SettlementDefinition, AirfieldProfile } from '../types';

/**
 * Which aircraft can use which field.
 *
 * This is what turns six settlements that differed only in their price table
 * into six places with their own character, and what gives the fleet a reason
 * to exist: the bush plane is the ONLY thing that gets into Highreach, and the
 * heavy freight out of Irongate is not going anywhere in a crop duster. Buying
 * a bigger aeroplane now closes doors as well as opening them, which is the
 * trade a cargo pilot actually makes.
 */

/** Runway a field effectively offers, once altitude is taken into account. */
export function effectiveRunwayM(field: AirfieldProfile): number {
  // Thin air at altitude means a longer roll for the same aeroplane. ~4% per
  // 300 m is the usual rule of thumb, and it is what makes a high mountain
  // shelf meaningfully harder than a short strip at sea level.
  const densityPenalty = 1 + (field.elevationM / 300) * 0.04;
  return field.runwayM / densityPenalty;
}

export interface FieldVerdict {
  ok: boolean;
  /** Runway remaining after the aircraft's requirement, in metres. */
  marginM: number;
  reason: string;
}

export function canOperate(
  def: AircraftDefinition,
  settlement: SettlementDefinition,
): FieldVerdict {
  const need = def.stats.runwayM;
  const have = effectiveRunwayM(settlement.field);
  const marginM = Math.round(have - need);
  if (marginM >= 0) {
    return {
      ok: true,
      marginM,
      reason: marginM < need * 0.15
        ? `${Math.round(have)} m usable — tight for the ${def.name}.`
        : `${Math.round(have)} m usable.`,
    };
  }
  return {
    ok: false,
    marginM,
    reason: `${settlement.name} has ${Math.round(have)} m of runway; the ${def.name} needs ${need} m.`,
  };
}

/** Short label for the chart. */
export function fieldSummary(settlement: SettlementDefinition): string {
  const f = settlement.field;
  return `${f.runwayM} m · ${f.approach}${f.elevationM >= 800 ? ` · ${f.elevationM} m ASL` : ''}`;
}
