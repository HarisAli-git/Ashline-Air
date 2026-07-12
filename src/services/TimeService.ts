import { SaveService } from './SaveService';
import { EconomyService } from './EconomyService';
import { ContractService } from './ContractService';
import { EventBus } from '../game/utils/EventBus';

const ECONOMY_STEP_MINUTES = 30;
const MAX_ECONOMY_STEPS = 20; // cap catch-up after long gaps

/**
 * The world clock. One real second of flight = one in-game minute; ground
 * services cost time too. Advancing time drives the economy drift and the
 * contract lifecycle (expiry + board top-up), then persists everything.
 */
class TimeServiceClass {
  advance(minutes: number): void {
    if (minutes <= 0) return;
    const save = SaveService.get();

    const before = save.world.gameTimestamp;
    save.world.gameTimestamp = Math.round(before + minutes);

    // One economy drift step per full 30-minute chunk crossed
    const steps = Math.min(
      MAX_ECONOMY_STEPS,
      Math.floor(save.world.gameTimestamp / ECONOMY_STEP_MINUTES) - Math.floor(before / ECONOMY_STEP_MINUTES),
    );
    if (steps > 0) {
      save.world.settlements = EconomyService.step(save.world.settlements, steps);
    }

    ContractService.maintainBoard(save);

    SaveService.save(save.player, save.world);
    EventBus.emit('economy:tick', { gameTimestamp: save.world.gameTimestamp });
  }
}

export const TimeService = new TimeServiceClass();
