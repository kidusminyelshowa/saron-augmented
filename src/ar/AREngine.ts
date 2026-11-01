/**
 * AREngine
 *
 * Wraps MindAR + Three.js initialization and lifecycle.
 * Provides a clean interface for the rest of the application to:
 *  - Start/stop the AR session
 *  - Add content to tracked anchors
 *  - React to target found/lost events
 *  - Inspect image target dimensions and aspect ratio
 */

import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js';
import type { Anchor } from 'mind-ar/dist/mindar-image-three.prod.js';
import { Vector3 } from 'three';
import { LightEstimator, type LightReference } from './LightEstimator';
import type { Scene, Camera, WebGLRenderer, Group } from 'three';

/**
 * Time constant (seconds) for smoothing the view angle used for parallax.
 * Longer = steadier but lazier parallax. Tracking jitter is far faster than
 * a person walking, so a short low-pass removes it without visible lag.
 */
const VIEW_ANGLE_SMOOTHING = 0.25;

/** Maximum view tangent passed to layers (~50°), to avoid extreme shifts. */
const MAX_VIEW_TANGENT = 1.2;

/** How often (ms) to re-measure the scene light from the camera feed. */
const LIGHT_SAMPLE_INTERVAL = 200;

/** Fraction of the mural (from its centre) sampled for lighting; avoids the surrounding wall. */
const LIGHT_SAMPLE_REGION = 0.8;

export interface AREngineOptions {
  /** DOM element to render into. */
  container: HTMLElement;
  /** Path to the .mind image target file. */
  targetSrc: string;
  /** Callback when the mural target is detected. */
  onTargetFound?: () => void;
  /** Callback when the mural target is lost. */
  onTargetLost?: () => void;
  /**
   * Called every frame while tracking with the smoothed view direction,
   * as tangents (camera x / distance, camera y / distance) in anchor space.
   */
  onViewAngle?: (tanX: number, tanY: number) => void;
  /** Called a few times a second while tracking with the per-channel light multiplier. */
  onLight?: (r: number, g: number, b: number) => void;
  /** Light matching settings. Strength 0 disables it. */
  light?: { reference?: LightReference; strength?: number };
  /** Target aspect ratio (width / height), used to locate the mural in the camera image. */
  aspectRatio?: number;
}

export class AREngine {
  public readonly renderer: WebGLRenderer;
  public readonly scene: Scene;
  public readonly camera: Camera;
  public readonly anchorGroup: Group;

  private mindar: InstanceType<typeof MindARThree>;
  private anchor: Anchor;
  private options: AREngineOptions;
  private smoothTanX = 0;
  private smoothTanY = 0;
  private snapViewAngle = true;
  private lastFrameTime = 0;
  private readonly cameraLocal = new Vector3();
  private readonly corner = new Vector3();
  private lightEstimator: LightEstimator;
  private lastLightSample = 0;

  constructor(options: AREngineOptions) {
    this.options = options;
    this.lightEstimator = new LightEstimator(options.light);

    // Initialize MindAR with custom tracking filters for maximum smoothness and stability.
    this.mindar = new MindARThree({
      container: options.container,
      imageTargetSrc: options.targetSrc,
      uiLoading: 'no',
      uiScanning: 'no',
      uiError: 'no',
      filterMinCF: 0.001,  // Balanced cutoff frequency: eliminates static jitter without introducing motion lag
      filterBeta: 0.01,    // Responsive tracking catch-up on movement
      warmupTolerance: 5,
      missTolerance: 5,
    });

    this.renderer = this.mindar.renderer;
    this.scene = this.mindar.scene;
    this.camera = this.mindar.camera;

    // Create an anchor for image target index 0 (the mural)
    this.anchor = this.mindar.addAnchor(0);
    this.anchorGroup = this.anchor.group;

    // Wire up target events directly on MindAR anchor callbacks
    this.anchor.onTargetFound = () => {
      console.log('[AREngine] Target Found');
      this.snapViewAngle = true;
      this.options.onTargetFound?.();
    };

    this.anchor.onTargetLost = () => {
      console.log('[AREngine] Target Lost');
      this.options.onTargetLost?.();
    };
  }

  /** Dimensions [width, height] of the tracked image target. */
  get targetDimensions(): [number, number] | null {
    const controller = (this.mindar as unknown as { controller?: { markerDimensions?: number[][] } }).controller;
    const dims = controller?.markerDimensions?.[0];
    if (Array.isArray(dims) && dims.length === 2 && dims[0] > 0 && dims[1] > 0) {
      return [dims[0], dims[1]];
    }
    return null;
  }

  /** Detected target aspect ratio (width / height) from the compiled .mind file. */
  get detectedAspectRatio(): number | null {
    const dims = this.targetDimensions;
    if (dims) {
      return dims[0] / dims[1];
    }
    return null;
  }

  /** Start the AR session (requests camera, begins tracking). */
  async start(): Promise<void> {
    await this.mindar.start();
    this.renderer.setAnimationLoop((time: number) => {
      this.updateViewAngle(time);
      this.updateLight(time);
      this.renderer.render(this.scene, this.camera);
    });
  }

  /** Measure scene light where the mural appears in the camera image and report it. */
  private updateLight(time: number): void {
    if (!this.options.onLight || !this.anchorGroup.visible) return;
    if (time - this.lastLightSample < LIGHT_SAMPLE_INTERVAL) return;
    this.lastLightSample = time;

    const video = this.mindar.video;
    if (!video || !video.videoWidth) return;

    // Project the (inset) mural corners to screen pixels.
    const ar = this.options.aspectRatio || this.detectedAspectRatio || 1;
    const hw = 0.5 * LIGHT_SAMPLE_REGION;
    const hh = (0.5 / ar) * LIGHT_SAMPLE_REGION;
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    this.anchorGroup.updateMatrixWorld();
    for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
      this.corner.set(x, y, 0).applyMatrix4(this.anchorGroup.matrixWorld).project(this.camera);
      const px = canvasRect.left + ((this.corner.x + 1) / 2) * canvasRect.width;
      const py = canvasRect.top + ((1 - this.corner.y) / 2) * canvasRect.height;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }

    // Screen pixels → camera video pixels (the video element is scaled to cover the container).
    const videoRect = video.getBoundingClientRect();
    if (!videoRect.width || !videoRect.height) return;
    const sx = video.videoWidth / videoRect.width;
    const sy = video.videoHeight / videoRect.height;
    const x0 = Math.max((minX - videoRect.left) * sx, 0);
    const y0 = Math.max((minY - videoRect.top) * sy, 0);
    const x1 = Math.min((maxX - videoRect.left) * sx, video.videoWidth);
    const y1 = Math.min((maxY - videoRect.top) * sy, video.videoHeight);

    const light = this.lightEstimator.sample(video, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    if (light) this.options.onLight(light[0], light[1], light[2]);
  }

  /** Compute the smoothed camera direction relative to the mural and report it. */
  private updateViewAngle(time: number): void {
    const dt = this.lastFrameTime ? Math.min((time - this.lastFrameTime) / 1000, 0.1) : 0;
    this.lastFrameTime = time;
    if (!this.options.onViewAngle || !this.anchorGroup.visible) return;

    // Camera position in the mural's local space (mural plane is z = 0, viewer at +z).
    this.anchorGroup.updateMatrixWorld();
    this.camera.getWorldPosition(this.cameraLocal);
    this.anchorGroup.worldToLocal(this.cameraLocal);
    const { x, y, z } = this.cameraLocal;
    if (z <= 0.01) return;

    const clamp = (v: number) => Math.max(-MAX_VIEW_TANGENT, Math.min(MAX_VIEW_TANGENT, v));
    const tanX = clamp(x / z);
    const tanY = clamp(y / z);

    if (this.snapViewAngle) {
      this.smoothTanX = tanX;
      this.smoothTanY = tanY;
      this.snapViewAngle = false;
    } else {
      const a = 1 - Math.exp(-dt / VIEW_ANGLE_SMOOTHING);
      this.smoothTanX += (tanX - this.smoothTanX) * a;
      this.smoothTanY += (tanY - this.smoothTanY) * a;
    }

    this.options.onViewAngle(this.smoothTanX, this.smoothTanY);
  }

  /** Stop the AR session and release resources. */
  stop(): void {
    this.renderer.setAnimationLoop(null);
    this.mindar.stop();
  }
}
