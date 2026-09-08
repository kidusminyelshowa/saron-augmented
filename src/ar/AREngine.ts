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
import type { Scene, Camera, WebGLRenderer, Group } from 'three';

export interface AREngineOptions {
  /** DOM element to render into. */
  container: HTMLElement;
  /** Path to the .mind image target file. */
  targetSrc: string;
  /** Callback when the mural target is detected. */
  onTargetFound?: () => void;
  /** Callback when the mural target is lost. */
  onTargetLost?: () => void;
}

export class AREngine {
  public readonly renderer: WebGLRenderer;
  public readonly scene: Scene;
  public readonly camera: Camera;
  public readonly anchorGroup: Group;

  private mindar: InstanceType<typeof MindARThree>;
  private anchor: Anchor;
  private options: AREngineOptions;

  constructor(options: AREngineOptions) {
    this.options = options;

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
    this.renderer.setAnimationLoop(() => {
      this.renderer.render(this.scene, this.camera);
    });
  }

  /** Stop the AR session and release resources. */
  stop(): void {
    this.renderer.setAnimationLoop(null);
    this.mindar.stop();
  }
}
