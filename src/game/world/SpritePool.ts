import Phaser from 'phaser';

/**
 * A fixed pool of images for one layer of the world.
 *
 * Graphics can only fill hard-edged shapes, and the world drew its smoke, mist
 * and ground patches out of them — stacks of discs and ellipses, each with an
 * edge the eye finds. A soft texture placed as a sprite has no edge, and it is
 * cheaper: a sprite is one quad, where a Graphics ellipse is re-tessellated
 * every frame (the terrain Graphics are the biggest cost in the frame).
 *
 * Created once, straight after the layer it belongs to, so every sprite sits
 * at that layer's place in the display list. Each frame claims what it needs
 * between begin() and end(); end() hides the rest.
 */
export class SpritePool {
  private readonly pool: Phaser.GameObjects.Image[] = [];
  private used = 0;

  constructor(scene: Phaser.Scene, size: number, texture: string, frame?: string | number) {
    for (let i = 0; i < size; i++) {
      this.pool.push(scene.add.image(0, 0, texture, frame).setVisible(false));
    }
  }

  begin(): void {
    this.used = 0;
  }

  /** Visit every sprite in the pool once — for set-up (depth, origin). */
  forEach(fn: (img: Phaser.GameObjects.Image) => void): void {
    for (const img of this.pool) fn(img);
  }

  /** The next free sprite, already visible; null when the pool is spent. */
  next(): Phaser.GameObjects.Image | null {
    if (this.used >= this.pool.length) return null;
    const img = this.pool[this.used++];
    if (!img.visible) img.setVisible(true);
    return img;
  }

  end(): void {
    for (let i = this.used; i < this.pool.length; i++) {
      if (this.pool[i].visible) this.pool[i].setVisible(false);
    }
  }

  destroy(): void {
    for (const img of this.pool) img.destroy();
    this.pool.length = 0;
  }
}
