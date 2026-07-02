import Phaser from 'phaser';
import { SaveService } from '../../services/SaveService';
import { EconomyService } from '../../services/EconomyService';
import { ContractService } from '../../services/ContractService';

interface Star  { x: number; y: number; r: number; phase: number; spd: number; }
interface Dust  { x: number; y: number; alpha: number; sz: number; vx: number; vy: number; }

export class MenuScene extends Phaser.Scene {
  private staticGfx!: Phaser.GameObjects.Graphics;
  private animGfx!:   Phaser.GameObjects.Graphics;
  private stars:  Star[]  = [];
  private dust:   Dust[]  = [];
  private planeImg!: Phaser.GameObjects.Image;
  private t = 0;

  constructor() {
    super({ key: 'MenuScene' });
  }

  create(): void {
    const { width, height } = this.cameras.main;
    const cx = width / 2;
    const horizonY = Math.round(height * 0.62);

    // ── Static scene layers ─────────────────────────────────────────────────
    this.staticGfx = this.add.graphics();
    this.drawStatic(width, height, horizonY);
    this.seedStars(width, horizonY);
    this.seedDust(width, height, horizonY);

    // Animated overlay (cleared + redrawn every frame)
    this.animGfx = this.add.graphics();

    // ── Aircraft silhouette crossing behind the title ───────────────────────
    // setFlipX(true) so the plane faces RIGHT (source image faces left)
    this.planeImg = this.add.image(-200, height * 0.44, 'cargo_plane')
      .setDisplaySize(200, 112)
      .setAlpha(0.28)
      .setFlipX(true);

    this.tweens.add({
      targets: this.planeImg,
      x: width + 200,
      duration: 22000,
      ease: 'Linear',
      repeat: -1,
      onRepeat: () => {
        this.planeImg.setY(Phaser.Math.FloatBetween(height * 0.30, height * 0.54));
      },
    });

    // ── Typography ──────────────────────────────────────────────────────────
    const title = this.add.text(cx, height * 0.185, 'ASHLINE AIR', {
      fontSize: '60px',
      color: '#ffd080',
      fontFamily: 'monospace',
      fontStyle: 'bold',
      shadow: { offsetX: 0, offsetY: 0, color: '#cc5500', blur: 28, fill: true },
    }).setOrigin(0.5);

    // Slow amber pulse on the title
    this.tweens.add({
      targets: title,
      alpha: { from: 1.0, to: 0.80 },
      duration: 3200,
      ease: 'Sine.easeInOut',
      yoyo: true,
      repeat: -1,
    });

    this.add.text(cx, height * 0.295, '— Cargo pilots at the end of the world —', {
      fontSize: '14px',
      color: '#6a5a3a',
      fontFamily: 'monospace',
      fontStyle: 'italic',
    }).setOrigin(0.5);

    // Decorative horizontal rule
    const ruleGfx = this.add.graphics();
    ruleGfx.lineStyle(1, 0x5a4a20, 0.45);
    ruleGfx.lineBetween(cx - 160, height * 0.368, cx + 160, height * 0.368);

    // ── Buttons ─────────────────────────────────────────────────────────────
    this.makeButton(cx, height * 0.485, 'NEW GAME', () => {
      SaveService.deleteSave();
      const save = SaveService.load();
      save.world.settlements = EconomyService.initialise(window.gameData.settlements);
      save.world.availableContracts = ContractService.refreshBoard(
        window.gameData.settlements,
        save.player.unlockedSettlementIds,
        save.player.reputation,
        save.world.gameTimestamp
      );
      SaveService.save(save.player, save.world);
      this.scene.start('MapScene');
    });

    if (SaveService.hasSave()) {
      this.makeButton(cx, height * 0.595, 'CONTINUE', () => {
        this.scene.start('MapScene');
      });
    } else {
      this.add.text(cx, height * 0.595, 'CONTINUE', {
        fontSize: '22px',
        color: '#2e2818',
        fontFamily: 'monospace',
      }).setOrigin(0.5);
    }

    // ── Bottom status bar ───────────────────────────────────────────────────
    const barGfx = this.add.graphics();
    barGfx.fillStyle(0x5a4a20, 0.18);
    barGfx.fillRect(0, height - 30, width, 30);
    barGfx.lineStyle(1, 0x5a4a20, 0.35);
    barGfx.lineBetween(0, height - 30, width, height - 30);

    this.add.text(14, height - 15, 'ASHLINE AIR  ·  POST-APOCALYPTIC CARGO SIMULATION', {
      fontSize: '10px', color: '#3a3020', fontFamily: 'monospace',
    }).setOrigin(0, 0.5);

    this.add.text(width - 14, height - 15, 'v0.1.0', {
      fontSize: '10px', color: '#3a3020', fontFamily: 'monospace',
    }).setOrigin(1, 0.5);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private drawStatic(width: number, height: number, horizonY: number): void {
    const g = this.staticGfx;

    // Sky — near-black at top, dark amber at horizon
    g.fillGradientStyle(0x02040a, 0x02040a, 0x140c04, 0x140c04, 1);
    g.fillRect(0, 0, width, horizonY);

    // Horizon glow — stacked amber bands
    for (let i = 6; i >= 0; i--) {
      const bandH = (i + 1) * 20;
      g.fillStyle(0xff5500, 0.03 + (6 - i) * 0.012);
      g.fillRect(0, horizonY - bandH, width, bandH);
    }

    // Mountain silhouette — triangle peaks rising from horizon
    g.fillStyle(0x080604, 1);
    const peaks: [number, number, number][] = [
      // [centerX, peakHeight, halfBaseWidth]
      [30,  38, 55],  [105, 65, 80],  [190, 42, 58],
      [275, 72, 90],  [370, 50, 68],  [460, 78, 95],
      [555, 44, 62],  [645, 68, 84],  [735, 55, 74],
      [width - 30, 40, 60],
    ];
    for (const [pcx, ph, hw] of peaks) {
      g.fillTriangle(
        pcx - hw, horizonY + 8,
        pcx,       horizonY - ph,
        pcx + hw, horizonY + 8,
      );
    }

    // Ground fill
    g.fillRect(0, horizonY, width, height - horizonY);

    // Subtle ground scanlines
    g.lineStyle(1, 0x1c1208, 0.45);
    for (let y = horizonY + 8; y < height - 30; y += 16) {
      g.lineBetween(0, y, width, y);
    }
  }

  private seedStars(width: number, horizonY: number): void {
    for (let i = 0; i < 130; i++) {
      const x   = Phaser.Math.Between(0, width);
      const y   = Phaser.Math.Between(2, horizonY - 24);
      const r   = Phaser.Math.FloatBetween(0.6, 2.0);
      const ph  = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const spd = Phaser.Math.FloatBetween(0.25, 1.1);
      this.stars.push({ x, y, r, phase: ph, spd });

      // Static base dot so stars are always slightly visible
      this.staticGfx.fillStyle(0xfff4e0, Phaser.Math.FloatBetween(0.08, 0.22));
      this.staticGfx.fillRect(x, y, r, r);
    }
  }

  private seedDust(width: number, height: number, horizonY: number): void {
    for (let i = 0; i < 40; i++) {
      this.dust.push({
        x:     Phaser.Math.FloatBetween(0, width),
        y:     Phaser.Math.FloatBetween(horizonY - 40, height - 30),
        alpha: Phaser.Math.FloatBetween(0.025, 0.10),
        sz:    Phaser.Math.FloatBetween(1, 3),
        vx:    Phaser.Math.FloatBetween(-0.12, 0.12),
        vy:    Phaser.Math.FloatBetween(-0.06, -0.28),
      });
    }
  }

  update(_time: number, delta: number): void {
    const { width, height } = this.cameras.main;
    const horizonY = Math.round(height * 0.62);
    this.t += delta / 1000;

    const g = this.animGfx;
    g.clear();

    // Twinkling stars
    for (const s of this.stars) {
      const tw = 0.5 + 0.5 * Math.sin(this.t * s.spd + s.phase);
      g.fillStyle(0xfff4e0, tw * 0.45);
      g.fillRect(s.x, s.y, s.r, s.r);
    }

    // Floating dust
    for (const d of this.dust) {
      d.x += d.vx;
      d.y += d.vy;
      if (d.y < horizonY - 60) {
        d.y = Phaser.Math.FloatBetween(height - 30, height);
        d.x = Phaser.Math.FloatBetween(0, width);
      }
      if (d.x < 0) d.x += width;
      else if (d.x > width) d.x -= width;
      g.fillStyle(0xdd8833, d.alpha);
      g.fillRect(d.x, d.y, d.sz, d.sz);
    }
  }

  private makeButton(x: number, y: number, label: string, onClick: () => void): void {
    const bw = 210, bh = 40;
    const bx = x - bw / 2, by = y - bh / 2;

    const boxGfx = this.add.graphics();
    const drawBox = (hover: boolean) => {
      boxGfx.clear();
      if (hover) {
        boxGfx.fillStyle(0xffd080, 0.07);
        boxGfx.fillRect(bx, by, bw, bh);
        boxGfx.lineStyle(1, 0xffd080, 0.75);
      } else {
        boxGfx.lineStyle(1, 0x5a4a20, 0.45);
      }
      boxGfx.strokeRect(bx, by, bw, bh);
    };
    drawBox(false);

    const text = this.add.text(x, y, label, {
      fontSize: '22px',
      color: '#b8a878',
      fontFamily: 'monospace',
      fontStyle: 'bold',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    text.on('pointerover',  () => { drawBox(true);  text.setStyle({ color: '#ffd080' }); });
    text.on('pointerout',   () => { drawBox(false); text.setStyle({ color: '#b8a878' }); });
    text.on('pointerdown', onClick);
  }
}
