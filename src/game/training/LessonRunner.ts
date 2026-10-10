import type { FlightState } from '../../types';
import type { ControlAction } from '../utils/controls';
import type { GoalClock, GoalDef, HudPart, LessonCtx, LessonDef, LessonId, LessonMetrics } from './lessons';

/** What the card shows for the goal in hand. */
export interface LessonView {
  id: LessonId;
  n: number;
  title: string;
  /** Which goal, 1-based, of how many. */
  step: number;
  total: number;
  text: string;
  keys: ControlAction[];
  focus?: HudPart;
  guide?: { lo: number; hi: number };
  speedBand?: { lo: number; hi: number };
  hud: HudPart[];
  /** The goal finished on this update, for the tick and the chime. */
  justDone: string | null;
}

export interface LessonResult {
  id: LessonId;
  passed: boolean;
  stars: number;
  reason?: string;
  criteria: Array<{ text: string; met: boolean }>;
  seconds: number;
}

/**
 * Walks a lesson's goals one at a time.
 *
 * Pure: it is handed the flight state and what the scene knows each frame,
 * and says which goal is current, when one is done, and — at the end — how
 * it went. Nothing here draws or flies anything.
 */
export class LessonRunner {
  private readonly goals: GoalDef[];
  private i = 0;
  private clock: GoalClock = { t: 0, startSpeedKmh: 0, startHeading: 1 };
  private holdT = 0;
  private started = false;
  private metrics: LessonMetrics = { seconds: 0, stalled: false, damage: 0, landing: null, onRunway: false };
  private outcome: LessonResult | null = null;

  private readonly def: LessonDef;

  constructor(def: LessonDef, ctx0: LessonCtx) {
    this.def = def;
    this.goals = def.goals.filter(g => !g.skip?.(ctx0));
  }

  get result(): LessonResult | null { return this.outcome; }

  update(dt: number, s: FlightState, c: LessonCtx): LessonView {
    if (!this.started) { this.started = true; this.startGoal(s, c); }
    let justDone: string | null = null;
    if (!this.outcome) {
      this.metrics.seconds += dt;
      if (c.stall && s.altitude > 3) this.metrics.stalled = true;
      this.metrics.damage = c.damage;
      this.metrics.landing = c.landing;
      this.metrics.onRunway = c.onRunway;

      const reason = this.def.failIf?.(s, c) ?? null;
      if (reason) {
        this.fail(reason);
      } else {
        const g = this.goals[this.i];
        this.clock.t += dt;
        let done: boolean;
        if (g.hold) {
          this.holdT = g.hold.when(s, c) ? this.holdT + dt : 0;
          done = this.holdT >= g.hold.seconds;
        } else {
          done = g.done?.(s, c, this.clock) ?? false;
        }
        if (done) {
          justDone = g.text(c);
          this.i++;
          if (this.i >= this.goals.length) this.finish(true);
          else this.startGoal(s, c);
        }
      }
    }
    return this.view(c, justDone);
  }

  /** End the lesson as failed — a crash, or the flight ending early. */
  fail(reason: string): void {
    if (this.outcome) return;
    this.finish(false, reason);
  }

  private startGoal(s: FlightState, c: LessonCtx): void {
    this.clock = { t: 0, startSpeedKmh: s.speed * 3.6, startHeading: c.heading };
    this.holdT = 0;
  }

  private finish(passed: boolean, reason?: string): void {
    const m = this.metrics;
    const criteria = [
      { text: this.def.passText, met: passed },
      ...this.def.stars.map(r => ({ text: r.text, met: passed && r.met(m) })),
    ];
    this.outcome = {
      id: this.def.id, passed, reason,
      stars: passed ? criteria.filter(x => x.met).length : 0,
      criteria, seconds: m.seconds,
    };
  }

  private view(c: LessonCtx, justDone: string | null): LessonView {
    const g = this.goals[Math.min(this.i, this.goals.length - 1)];
    return {
      id: this.def.id, n: this.def.n, title: this.def.title,
      step: Math.min(this.i + 1, this.goals.length), total: this.goals.length,
      text: g.text(c), keys: g.keys ?? [], focus: g.focus, guide: g.guide,
      speedBand: g.speedBand?.(c), hud: this.def.hud, justDone,
    };
  }
}
