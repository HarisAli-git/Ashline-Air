export type GoodCategory =
  | 'food'
  | 'medicine'
  | 'water'
  | 'electronics'
  | 'machinery'
  | 'fuel'
  | 'artifact'
  | 'ammunition';

export interface GoodDefinition {
  id: string;
  name: string;
  category: GoodCategory;
  description: string;
  weightPerUnit: number;   // kg per unit
  baseValue: number;       // base currency value per unit
  fragile: boolean;        // if true, rough landings reduce condition
  perishable: boolean;     // if true, long flights reduce condition
  illegal: boolean;        // affects which factions will offer/accept
}
