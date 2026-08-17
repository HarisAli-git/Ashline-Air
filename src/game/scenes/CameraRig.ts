import Phaser from 'phaser';
import type { FlightState } from '../../types';
import { clamp } from '../utils/math';

/**
 * What turns a correct simulation into something that feels like flying.
 *
 * The aeroplane sat at a fixed screen position and moved only when its
 * altitude changed, so every manoeuvre looked identical: the numbers changed
 * and the picture did not. That is the "controlling something fixed on the
 * screen" complaint, and no amount of physics fixes it, because it is not a
 * physics problem — nothing was ever SHOWING you the physics.
 *
 * Deliberately NOT reintroduced: the aircraft sliding across the screen with
 * airspeed. That was tried, rejected, and is not what any of this is. Every
 * offset here is a spring-damped response to an ACCELERATION — g-load, pitch
 * rate, turbulence — so it moves when the aeroplane is being flown and settles
 * when it is trimmed. It lags and overshoots on purpose: the lag is the weight.
 */

/** Hard bounds, in design pixels — the aeroplane must never leave its zone. */
const MAX_DX = 26;
const MAX_DY = 34;
const MAX_ROLL_DEG = 1.6;

/**
 * The zoom a rolled camera needs before it stops showing the edge of the world.
 *
 * A fixed overscan is wrong here: the requirement depends on the canvas ASPECT,
 * and the design canvas is now shaped like whatever device is playing (see
 * GameSize.ts). A flat 1.03 covered a 16:9 frame and left bare corners on a
 * phone's 2.16:1 one. Rotating a w×h rectangle about its centre, the scale that
 * still covers the frame is cos θ + (w/h)·sin θ — so solve it every frame and
 * the roll is safe at any shape.
 */
const zoomForRoll = (deg: number, w: number, h: number): number => {
  const t = Math.abs(Phaser.Math.DegToRad(deg));
  return Math.cos(t) + (w / Math.max(1, h)) * Math.sin(t);
};

interface Spring { v: number; x: number }

const step = (s: Spring, target: number, stiffness: number, damping: number, dt: number): void => {
  s.v += (target - s.x) * stiffness * dt;
  s.v *= Math.exp(-damping * dt);
  s.x += s.v * dt;
};

export class CameraRig {
  private readonly dx: Spring = { v: 0, x: 0 };
  private readonly dy: Spring = { v: 0, x: 0 };
  private readonly roll: Spring = { v: 0, x: 0 };
  private zoom = 1;
  private shakeCooldown = 0;

  private readonly cam: Phaser.Cameras.Scene2D.Camera;
  private readonly vStall: number;
  private readonly vMax: number;

  constructor(cam: Phaser.Cameras.Scene2D.Camera, vStall: number, vMax: number) {
    this.cam = cam;
    this.vStall = vStall;
    this.vMax = vMax;
    cam.setZoom(1);
  }

  /** Screen offset to add to the aircraft's own position, in design px. */
  get offsetX(): number { return this.dx.x; }
  get offsetY(): number { return this.dy.x; }

  update(dt: number, s: FlightState, turbulence: number, onGround: boolean): void {
    const d = Math.min(dt, 1 / 30);

    if (onGround) {
      // On the runway the aeroplane belongs to the ground, not to the air.
      step(this.dx, 0, 40, 9, d);
      step(this.dy, 0, 40, 9, d);
      step(this.roll, 0, 30, 9, d);
    } else {
      // Pull g and the airframe settles back and low in frame; push and it
      // floats forward and high. This is the g-load you can SEE.
      const g = clamp(s.loadFactor - 1, -1.6, 3);
      // Flight path drives the vertical framing: climbing shows you more sky,
      // diving shows you more ground — the camera looks where you are going.
      const climb = clamp(s.verticalSpeed / 14, -1, 1);

      step(this.dx, clamp(-g * 9 - s.pitchRate * 0.18, -MAX_DX, MAX_DX), 26, 7.5, d);
      step(this.dy, clamp(g * 11 - climb * 16, -MAX_DY, MAX_DY), 22, 6.5, d);
      // A touch of roll as the airframe is loaded or shoved about by weather
      step(this.roll, clamp(g * 0.5 + (Math.random() - 0.5) * turbulence * 2.2, -MAX_ROLL_DEG, MAX_ROLL_DEG), 14, 6, d);
    }

    // Speed compresses the view — a small, continuous cue that does not move
    // the aeroplane, so it reads as going faster rather than drifting.
    const vFrac = clamp((s.speed - this.vStall) / Math.max(1, this.vMax - this.vStall), 0, 1);
    const zoomTarget = 1 + vFrac * 0.055;
    this.zoom += (zoomTarget - this.zoom) * Math.min(1, d * 2.2);

    // …but never less than the roll needs, or the frame shows bare corners.
    const safe = zoomForRoll(this.roll.x, this.cam.width, this.cam.height);
    this.cam.setZoom(Math.max(this.zoom, safe));
    this.cam.setRotation(Phaser.Math.DegToRad(this.roll.x));

    // Hard manoeuvring and rough air rattle the airframe. Intensity is a
    // FRACTION of the screen — integers here teleport the camera.
    this.shakeCooldown -= d;
    const rattle = Math.max(Math.abs(s.loadFactor - 1) * 0.55, turbulence);
    if (rattle > 0.55 && this.shakeCooldown <= 0) {
      this.cam.shake(140, clamp(0.0016 * rattle, 0.0012, 0.006));
      this.shakeCooldown = 0.16;
    }
  }

  /** Put everything back before handing the camera to another scene. */
  reset(): void {
    this.cam.setZoom(1);
    this.cam.setRotation(0);
  }
}
