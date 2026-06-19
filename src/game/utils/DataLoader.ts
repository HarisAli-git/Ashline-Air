import type {
  AircraftDefinition,
  GoodDefinition,
  SettlementDefinition,
  FlightEventDefinition,
  FactionDefinition,
} from '../../types';

export interface GameData {
  aircraft: AircraftDefinition[];
  goods: GoodDefinition[];
  settlements: SettlementDefinition[];
  events: FlightEventDefinition[];
  factions: FactionDefinition[];
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function loadAllGameData(): Promise<GameData> {
  const [aircraft, goods, settlements, events, factions] = await Promise.all([
    fetchJson<AircraftDefinition[]>('/data/aircraft/aircraft.json'),
    fetchJson<GoodDefinition[]>('/data/goods/goods.json'),
    fetchJson<SettlementDefinition[]>('/data/settlements/settlements.json'),
    fetchJson<FlightEventDefinition[]>('/data/events/flight_events.json'),
    fetchJson<FactionDefinition[]>('/data/factions/factions.json'),
  ]);

  return { aircraft, goods, settlements, events, factions };
}

// Typed lookup helpers used throughout the codebase
export function findById<T extends { id: string }>(collection: T[], id: string): T {
  const item = collection.find(x => x.id === id);
  if (!item) throw new Error(`Item with id "${id}" not found`);
  return item;
}
