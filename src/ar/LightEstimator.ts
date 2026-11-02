/**
 * LightEstimator
 *
 * Estimates how the scene light differs from the artwork's authored colours by
 * averaging the camera pixels where the mural is, and turns that into a
 * per-channel multiplier for the video layers. This makes the layers darken
 * in shade or at dusk and pick up warm or cool casts, like the real paint.
 */

export type LightReference = [number, number, number] | number;

export interface LightEstimatorOptions {
  /** Average artwork colour (or luminance) under neutral light. See WallConfig.reference. */
  reference?: LightReference;
  /** How strongly to apply the estimate (0–1). */
  strength?: number;
}

/** Rectangle in the camera video's pixel space. */
export interface VideoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SAMPLE_SIZE = 32;
const MIN_MULTIPLIER = 0.35;
const MAX_MULTIPLIER = 1.3;
/** Fraction of the way to move towards each new measurement (smooths flicker). */
const SMOOTHING = 0.3;
/** Samples to average before fixing an automatic baseline when no reference is given. */
const BASELINE_SAMPLES = 5;

const luminance = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export class LightEstimator {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly strength: number;
  private reference: LightReference | null;
  private baselineSum = [0, 0, 0];
  private baselineCount = 0;
  private current: [number, number, number] = [1, 1, 1];

  constructor(options: LightEstimatorOptions = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SAMPLE_SIZE;
    this.canvas.height = SAMPLE_SIZE;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.strength = Math.min(Math.max(options.strength ?? 0.8, 0), 1);
    this.reference = options.reference ?? null;
  }

  /**
   * Measure the given region of the camera video (or a canvas holding a camera frame) and return the smoothed
   * light multiplier, or null if nothing could be measured.
   */
  sample(video: HTMLVideoElement | HTMLCanvasElement, rect: VideoRect): [number, number, number] | null {
    if (!this.ctx || this.strength === 0) return null;
    if (video instanceof HTMLVideoElement && video.readyState < 2) return null;
    if (rect.width < 4 || rect.height < 4) return null;

    let pixels: Uint8ClampedArray;
    try {
      this.ctx.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      pixels = this.ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
    } catch {
      return null;
    }

    const mean = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) {
      mean[0] += pixels[i];
      mean[1] += pixels[i + 1];
      mean[2] += pixels[i + 2];
    }
    const n = (pixels.length / 4) * 255;
    mean[0] /= n;
    mean[1] /= n;
    mean[2] /= n;

    // Without a reference, use the first few measurements as "normal" light,
    // so the estimate follows changes (clouds, dusk) from that point on.
    if (this.reference === null) {
      this.baselineSum[0] += mean[0];
      this.baselineSum[1] += mean[1];
      this.baselineSum[2] += mean[2];
      this.baselineCount++;
      if (this.baselineCount < BASELINE_SAMPLES) return this.current;
      this.reference = this.baselineSum.map((v) => v / this.baselineCount) as [number, number, number];
    }

    let ratio: number[];
    if (typeof this.reference === 'number') {
      const r = luminance(mean) / Math.max(this.reference, 0.02);
      ratio = [r, r, r];
    } else {
      const ref = this.reference;
      ratio = mean.map((v, i) => v / Math.max(ref[i], 0.02));
    }

    for (let i = 0; i < 3; i++) {
      const clamped = Math.min(Math.max(ratio[i], MIN_MULTIPLIER), MAX_MULTIPLIER);
      const target = 1 + (clamped - 1) * this.strength;
      this.current[i] += (target - this.current[i]) * SMOOTHING;
    }
    return this.current;
  }
}
