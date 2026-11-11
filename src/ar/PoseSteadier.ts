import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Group } from 'three';

/** Below these changes the phone is treated as still (mural widths / degrees). */
const STILL_MOVE = 0.012;
const STILL_TURN = 1.2;
/** Above these the phone is clearly moving and the picture follows quickly. */
const MOVING_MOVE = 0.04;
const MOVING_TURN = 4;
/** Time constants (seconds): very slow drift while still, near-instant while moving. */
const STILL_LAG = 1.2;
const MOVING_LAG = 0.02;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Steadies a MindAR anchor's pose. MindAR hands the anchor a new matrix
 * object on every tracker update; we keep that raw pose aside and show a
 * filtered one instead. Small changes (tracker jitter) are followed very
 * slowly, so a still phone gives a still picture; large changes (real
 * movement) are followed almost at once.
 */
export class PoseSteadier {
  private readonly out = new Matrix4();
  private raw: Matrix4 | null = null;
  private primed = false;
  private readonly pos = new Vector3();
  private readonly rot = new Quaternion();
  private readonly scl = new Vector3();
  private readonly rawPos = new Vector3();
  private readonly rawRot = new Quaternion();
  private readonly rawScl = new Vector3();

  /** Jump straight to the next pose (after the mural is found again). */
  reset(): void {
    this.primed = false;
  }

  /** Call once per rendered frame, before rendering. */
  update(group: Group, dt: number): void {
    if (group.matrix !== this.out) this.raw = group.matrix; // fresh pose from the tracker
    if (!this.raw || !group.visible) {
      this.primed = false;
      return;
    }
    this.raw.decompose(this.rawPos, this.rawRot, this.rawScl);

    if (!this.primed) {
      this.pos.copy(this.rawPos);
      this.rot.copy(this.rawRot);
      this.scl.copy(this.rawScl);
      this.primed = true;
    } else {
      const width = Math.max(this.rawScl.x, 1e-6);
      const move = this.pos.distanceTo(this.rawPos) / width;
      const turn = (this.rot.angleTo(this.rawRot) * 180) / Math.PI;
      const motion = Math.max(
        smoothstep(STILL_MOVE, MOVING_MOVE, move),
        smoothstep(STILL_TURN, MOVING_TURN, turn),
      );
      const lag = STILL_LAG + (MOVING_LAG - STILL_LAG) * motion;
      const a = 1 - Math.exp(-dt / lag);
      this.pos.lerp(this.rawPos, a);
      this.rot.slerp(this.rawRot, a);
      this.scl.lerp(this.rawScl, a);
    }

    this.out.compose(this.pos, this.rot, this.scl);
    group.matrix = this.out;
  }
}
