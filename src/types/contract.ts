export type ContractStatus = 'available' | 'active' | 'completed' | 'failed' | 'expired';
export type ContractType = 'cargo' | 'passenger' | 'emergency' | 'secret';

export interface Contract {
  id: string;
  type: ContractType;
  title: string;
  description: string;
  originId: string;      // settlement id
  destinationId: string; // settlement id
  factionId: string;     // issuing faction
  payload: ContractPayload[];
  reward: ContractReward;
  expiresAt: number;     // game timestamp
  timeLimit: number;     // max flight time in minutes
  status: ContractStatus;
  reputationRequirement: number; // min faction rep to accept
}

export interface ContractPayload {
  goodId: string;
  quantity: number;        // units
  totalWeightKg: number;
  minimumCondition: number; // 0–100, below this = failed delivery
}

export interface ContractReward {
  basePay: number;
  bonusPay: number;        // awarded for exceptional condition/time
  reputationGain: number;
  penaltyForFailure: number;
}
