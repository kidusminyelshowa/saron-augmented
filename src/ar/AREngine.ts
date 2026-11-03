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
import { Group as ThreeGroup, Vector3 } from 'three';
import { LightEstimator, type LightReference } from './LightEstimator';
import { PeopleMask } from './PeopleMask';
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
  /**
   * Region of the mural each image in the .mind file shows, as normalised
   * [x, y, width, height] (0..1, top-left origin), in the same order as the
   * images were compiled. Default: a single target covering the whole mural.
   * Extra close-up targets let phones without a wide camera lock on from
   * nearer the wall.
   */
  targetRegions?: [number, number, number, number][];
  /** Detect people in the camera image so layers can be hidden behind them. */
  occludePeople?: boolean;
  /** Called every frame while tracking with the people-occlusion strength (0 = no one in view). */
  onOcclusion?: (strength: number) => void;
}

type Region = [number, number, number, number];

export class AREngine {
  public readonly renderer: WebGLRenderer;
  public readonly scene: Scene;
  public readonly camera: Camera;
  /**
   * Holds all mural content in full-mural anchor space (width 1, height
   * 1 / aspectRatio). It is moved into whichever target's anchor is tracked.
   */
  public readonly contentGroup: Group = new ThreeGroup();

  private mindar: InstanceType<typeof MindARThree>;
  private anchors: Anchor[] = [];
  private regions: Region[];
  private activeAnchor = -1;
  private options: AREngineOptions;
  private smoothTanX = 0;
  private smoothTanY = 0;
  private snapViewAngle = true;
  private lastFrameTime = 0;
  private readonly cameraLocal = new Vector3();
  private readonly corner = new Vector3();
  private lightEstimator: LightEstimator;
  private lastLightSample = 0;
  /** Person mask for occlusion (null when disabled). Layers read its texture directly. */
  public readonly peopleMask: PeopleMask | null;

  constructor(options: AREngineOptions) {
    this.options = options;
    this.lightEstimator = new LightEstimator(options.light);
    this.peopleMask = options.occludePeople ? new PeopleMask() : null;

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

    // One anchor per compiled image: index 0 is the whole mural, any others are close-ups.
    this.regions = options.targetRegions?.length ? options.targetRegions : [[0, 0, 1, 1]];
    this.regions.forEach((_, index) => {
      const anchor = this.mindar.addAnchor(index);
      anchor.onTargetFound = () => this.handleFound(index);
      anchor.onTargetLost = () => this.handleLost(index);
      this.anchors.push(anchor);
    });
  }

  /** Group of the anchor currently holding the content (or null when nothing is tracked). */
  get anchorGroup(): Group | null {
    return this.activeAnchor >= 0 ? this.anchors[this.activeAnchor].group : null;
  }

  private handleFound(index: number): void {
    console.log(`[AREngine] Target Found (image ${index})`);
    const wasTracking = this.activeAnchor >= 0;
    if (index !== this.activeAnchor) {
      this.attachContent(index);
    }
    this.snapViewAngle = true;
    if (!wasTracking) this.options.onTargetFound?.();
  }

  private handleLost(index: number): void {
    console.log(`[AREngine] Target Lost (image ${index})`);
    if (index !== this.activeAnchor) return;
    this.activeAnchor = -1;
    this.options.onTargetLost?.();
  }

  /**
   * Move the content into anchor `index`, mapping full-mural space into that
   * image's anchor space (where the close-up's own width is 1).
   */
  private attachContent(index: number): void {
    const [rx, ry, rw, rh] = this.regions[index];
    const ar = this.options.aspectRatio || this.detectedAspectRatio || 1;
    const s = 1 / rw;
    const cx = rx + rw / 2 - 0.5;
    const cy = -(ry + rh / 2 - 0.5) / ar;
    this.contentGroup.position.set(-cx * s, -cy * s, 0);
    this.contentGroup.scale.setScalar(s);
    this.anchors[index].group.add(this.contentGroup);
    this.activeAnchor = index;
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
    // Load the people models in the background; tracking starts without them.
    this.peopleMask?.start();
    this.renderer.setAnimationLoop((time: number) => {
      this.updateViewAngle(time);
      this.updateLight(time);
      this.updateOcclusion(time);
      this.renderer.render(this.scene, this.camera);
    });
  }

  /** Keep the people mask fresh while the mural is tracked. */
  private updateOcclusion(time: number): void {
    const mask = this.peopleMask;
    const video = this.mindar.video;
    if (!mask || !video || !this.anchorGroup?.visible) return;
    mask.update(time, video, this.renderer.domElement);
    this.options.onOcclusion?.(mask.strength);
  }

  /** Measure scene light where the mural appears in the camera image and report it. */
  private updateLight(time: number): void {
    const anchor = this.anchorGroup;
    if (!this.options.onLight || !anchor?.visible) return;
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
    anchor.updateMatrixWorld();
    for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
      this.corner.set(x, y, 0).applyMatrix4(this.contentGroup.matrixWorld).project(this.camera);
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
    const anchor = this.anchorGroup;
    if (!this.options.onViewAngle || !anchor?.visible) return;

    // Camera position in the mural's local space (mural plane is z = 0, viewer at +z).
    anchor.updateMatrixWorld();
    this.camera.getWorldPosition(this.cameraLocal);
    this.contentGroup.worldToLocal(this.cameraLocal);
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
    this.peopleMask?.dispose();
    this.mindar.stop();
  }
}
