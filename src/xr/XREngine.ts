/**
 * XREngine
 *
 * Android (Chrome + ARCore) mode. Instead of recognising the painted image in
 * every frame, the mural is recognised once and then held in place by ARCore's
 * world tracking, the same way location-based AR games keep content in place.
 * That keeps the animation on the wall in harsh shadows, up close, and with
 * most of the wall out of view. ARCore's depth sensing also hides the
 * animation behind anything closer than the wall (people, poles, objects).
 *
 * Recognition uses MindAR's detector on the WebXR camera image (raw camera
 * access), alternating between the plain image and a shadow-removing filter
 * (see shadowFilter.ts). The match is turned into a real-size pose with the
 * camera's true projection (see muralPose.ts). While the wall stays in view,
 * new matches gently correct any drift.
 *
 * Exposes the same surface as AREngine (contentGroup, callbacks) so the video
 * layers work unchanged.
 */

import * as THREE from 'three';
import { Controller } from 'mind-ar/dist/mindar-image.prod.js';
import { LightEstimator, type LightReference } from '../ar/LightEstimator';
import { CameraReader } from './CameraReader';
import { DepthOcclusion } from './DepthOcclusion';
import { solveMuralPose } from './muralPose';
import { shadowInvariant } from './shadowFilter';

/** Time between recognition attempts before the mural is found (ms). */
const SEARCH_INTERVAL = 350;
/** Time between drift corrections once the mural is placed (ms). */
const REFINE_INTERVAL = 1500;
/** Largest acceptable mean reprojection error of a match (fraction of image height). */
const MAX_FIT_ERROR = 0.03;
/** Fraction of the way to move towards a consistent new match. */
const REFINE_BLEND = 0.3;
/** A match further than this (metres) from the current placement counts as disagreeing. */
const REFINE_MAX_JUMP = 1.0;
/** Consecutive disagreeing matches that make the placement jump to the new one. */
const REFINE_REPLACE_AFTER = 3;
/** View-angle smoothing time constant (s), as in AREngine. */
const VIEW_ANGLE_SMOOTHING = 0.25;
const MAX_VIEW_TANGENT = 1.2;
const LIGHT_SAMPLE_INTERVAL = 300;
const LIGHT_SAMPLE_REGION = 0.8;

export interface XREngineOptions {
  container: HTMLElement;
  /** MindAR targets compiled from the plain wall photo. */
  targetSrc: string;
  /** Same targets compiled from shadow-filtered images (tools/make_invariant_targets.py). */
  invariantTargetSrc?: string;
  /** Region of the mural each target shows (normalised x, y, w, h), as in AREngine. */
  targetRegions?: [number, number, number, number][];
  aspectRatio: number;
  /** Mural width in metres. */
  muralWidth: number;
  onTargetFound?: () => void;
  onTargetLost?: () => void;
  onViewAngle?: (tanX: number, tanY: number) => void;
  onLight?: (r: number, g: number, b: number) => void;
  light?: { reference?: LightReference; strength?: number };
  /** Called when the user leaves the AR session (e.g. the back button). */
  onEnded?: () => void;
}

interface Detector {
  name: string;
  src: string;
  shadowFilter: boolean;
  controller: InstanceType<typeof Controller> | null;
  dimensions: [number, number][];
}

/** Experimental WebXR members not yet in the TypeScript DOM typings. */
type XRCameraView = XRView & { camera?: { width: number; height: number } };
type CameraBinding = { getCameraImage(camera: unknown): WebGLTexture | null };

export class XREngine {
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene = new THREE.Scene();
  public readonly camera = new THREE.PerspectiveCamera(60, 1, 0.05, 200);
  public readonly contentGroup: THREE.Group = new THREE.Group();
  /** Person-mask occlusion is not used in this mode (depth sensing covers it). */
  public readonly peopleMask = null;
  public depth: DepthOcclusion | null = null;

  private readonly options: XREngineOptions;
  private readonly regions: [number, number, number, number][];
  private session: XRSession | null = null;
  private binding: CameraBinding | null = null;
  private reader: CameraReader | null = null;
  private detectors: Detector[] = [];
  private attempt = 0;
  private flipLocked: boolean | null = null;
  private busy = false;
  private lastDetect = 0;
  private placed = false;
  private disagreements = 0;
  private trackingLost = false;
  private lostSince = 0;
  private smoothTanX = 0;
  private smoothTanY = 0;
  private snapViewAngle = true;
  private lastFrameTime = 0;
  private lightEstimator: LightEstimator;
  private lastLightSample = 0;
  private readonly hud: HTMLElement | null = null;
  private readonly status: Record<string, string> = {};
  private ended = false;

  constructor(options: XREngineOptions) {
    this.options = options;
    this.regions = options.targetRegions?.length ? options.targetRegions : [[0, 0, 1, 1]];
    this.lightEstimator = new LightEstimator(options.light);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    options.container.appendChild(this.renderer.domElement);

    this.contentGroup.matrixAutoUpdate = false;
    this.contentGroup.visible = false;
    this.scene.add(this.contentGroup);

    this.detectors = [
      { name: 'plain', src: options.targetSrc, shadowFilter: false, controller: null, dimensions: [] },
    ];
    if (options.invariantTargetSrc) {
      this.detectors.push({
        name: 'shadow-filtered',
        src: options.invariantTargetSrc,
        shadowFilter: true,
        controller: null,
        dimensions: [],
      });
    }

    if (new URLSearchParams(location.search).get('debug') === 'xr') {
      this.hud = document.createElement('div');
      this.hud.style.cssText =
        'position:fixed;left:8px;bottom:8px;right:8px;z-index:9999;padding:6px 8px;border-radius:6px;' +
        'background:rgba(0,0,0,.7);color:#fff;font:11px/1.4 monospace;pointer-events:none;white-space:pre-wrap';
      document.body.appendChild(this.hud);
    }
  }

  /** True when this browser can run an ARCore session (Chrome on Android). */
  static async isSupported(): Promise<boolean> {
    try {
      return !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar'));
    } catch {
      return false;
    }
  }

  get detectedAspectRatio(): number | null {
    return this.options.aspectRatio;
  }

  private setStatus(key: string, value: string): void {
    this.status[key] = value;
    if (this.hud) this.hud.textContent = Object.entries(this.status).map(([k, v]) => `${k}: ${v}`).join('\n');
  }

  /** Start the AR session. Must be called soon after a user tap. Throws if unavailable. */
  async start(): Promise<void> {
    if (!navigator.xr) throw new Error('WebXR not available');
    const init = {
      requiredFeatures: ['camera-access'],
      optionalFeatures: ['depth-sensing', 'dom-overlay'],
      depthSensing: {
        usagePreference: ['cpu-optimized'],
        dataFormatPreference: ['luminance-alpha', 'float32'],
      },
      domOverlay: { root: document.body },
    } as XRSessionInit;
    const session = await navigator.xr.requestSession('immersive-ar', init);
    this.session = session;
    document.documentElement.classList.add('xr-session');
    session.addEventListener('end', () => this.handleEnd());

    await this.renderer.xr.setSession(session as unknown as XRSession);
    const gl = this.renderer.getContext();
    const BindingCtor = (window as unknown as { XRWebGLBinding?: new (s: XRSession, g: WebGLRenderingContext | WebGL2RenderingContext) => CameraBinding }).XRWebGLBinding;
    if (!BindingCtor) throw new Error('XRWebGLBinding not available');
    this.binding = new BindingCtor(session, gl);
    this.reader = new CameraReader(this.renderer);

    this.depth = new DepthOcclusion(session);
    this.setStatus('depth', this.depth.available ? 'on' : 'not available on this phone');
    this.setStatus('mural', 'searching');

    this.renderer.setAnimationLoop((time: number, frame?: XRFrame) => {
      if (frame) this.onFrame(time, frame);
      this.renderer.render(this.scene, this.camera);
    });
  }

  private onFrame(time: number, frame: XRFrame): void {
    const refSpace = this.renderer.xr.getReferenceSpace();
    if (!refSpace) return;
    const pose = frame.getViewerPose(refSpace);
    if (!pose) return;
    const view = pose.views[0] as XRCameraView;

    // Tracking quality: ARCore reports an emulated position while it's lost.
    this.updateTrackingState(time, pose.emulatedPosition);

    const layer = this.session?.renderState.baseLayer;
    if (layer) this.depth?.update(frame, view, layer.framebufferWidth, layer.framebufferHeight);

    const interval = this.placed ? REFINE_INTERVAL : SEARCH_INTERVAL;
    if (!this.busy && view.camera && this.binding && this.reader && time - this.lastDetect > interval) {
      this.lastDetect = time;
      this.captureAndDetect(view, time);
    }

    if (this.placed) {
      this.updateViewAngle(time, view);
    }
  }

  private updateTrackingState(time: number, emulated: boolean): void {
    if (!this.placed) return;
    if (emulated) {
      if (!this.lostSince) this.lostSince = time;
      if (!this.trackingLost && time - this.lostSince > 1000) {
        this.trackingLost = true;
        this.options.onTargetLost?.();
      }
    } else {
      this.lostSince = 0;
      if (this.trackingLost) {
        this.trackingLost = false;
        this.options.onTargetFound?.();
      }
    }
  }

  /** Read the camera image now (it's only valid during this frame), then match asynchronously. */
  private captureAndDetect(view: XRCameraView, time: number): void {
    const texture = this.binding!.getCameraImage(view.camera);
    if (!texture) return;

    // Before the first match, cycle through image orientation × filter until one works.
    const flips = this.flipLocked === null ? [false, true] : [this.flipLocked];
    const n = this.detectors.length * flips.length;
    const k = this.attempt++ % n;
    const detector = this.detectors[k % this.detectors.length];
    const flip = flips[Math.floor(k / this.detectors.length)];

    if (!this.reader!.read(texture, view.camera!.width, view.camera!.height, flip)) return;

    const projection = Array.from(view.projectionMatrix);
    const worldFromCamera = new THREE.Matrix4().fromArray(view.transform.matrix);
    this.sampleLight(time, projection, worldFromCamera);

    this.busy = true;
    this.detect(detector, flip, projection, worldFromCamera)
      .catch((err) => this.setStatus('error', String(err?.message ?? err)))
      .finally(() => {
        this.busy = false;
      });
  }

  private async ensureController(d: Detector, w: number, h: number): Promise<void> {
    const c = d.controller as unknown as { inputWidth: number; inputHeight: number } | null;
    if (c && c.inputWidth === w && c.inputHeight === h) return;
    (d.controller as unknown as { dispose?: () => void } | null)?.dispose?.();
    const controller = new Controller({ inputWidth: w, inputHeight: h, maxTrack: 1 });
    const { dimensions } = await (controller as unknown as {
      addImageTargets(src: string): Promise<{ dimensions: [number, number][] }>;
    }).addImageTargets(d.src);
    d.controller = controller;
    d.dimensions = dimensions;
  }

  private async detect(d: Detector, flip: boolean, projection: number[], worldFromCamera: THREE.Matrix4): Promise<void> {
    const reader = this.reader!;
    const w = reader.width;
    const h = reader.height;
    await this.ensureController(d, w, h);

    let input: HTMLCanvasElement = reader.canvas;
    if (d.shadowFilter) {
      const filtered = document.createElement('canvas');
      filtered.width = w;
      filtered.height = h;
      const ctx = filtered.getContext('2d')!;
      const out = ctx.createImageData(w, h);
      shadowInvariant(reader.data, out.data);
      ctx.putImageData(out, 0, 0);
      input = filtered;
    }

    const controller = d.controller as unknown as {
      projectionTransform: number[][];
      detect(input: HTMLCanvasElement): Promise<{ featurePoints: unknown[] }>;
      match(fp: unknown[], i: number): Promise<{ modelViewTransform: number[][] | null }>;
    };
    const t0 = performance.now();
    const { featurePoints } = await controller.detect(input);
    for (let i = 0; i < d.dimensions.length; i++) {
      const { modelViewTransform } = await controller.match(featurePoints, i);
      if (!modelViewTransform) continue;
      const pose = solveMuralPose({
        modelViewTransform,
        mindarK: controller.projectionTransform,
        targetSize: d.dimensions[i],
        region: this.regions[i] ?? [0, 0, 1, 1],
        muralWidth: this.options.muralWidth,
        aspectRatio: this.options.aspectRatio,
        imageWidth: w,
        imageHeight: h,
        flippedY: false, // the reader already stored the image upright for this attempt
        projection,
      });
      const ms = (performance.now() - t0).toFixed(0);
      if (!pose || pose.error > MAX_FIT_ERROR * h || pose.distance < 0.5 || pose.distance > 80) {
        this.setStatus('last match', `${d.name} #${i} rejected (fit ${pose?.error.toFixed(1)} px, ${pose?.distance.toFixed(1)} m)`);
        continue;
      }
      this.setStatus('last match', `${d.name} #${i} flip=${flip} fit ${pose.error.toFixed(1)} px, ${pose.distance.toFixed(1)} m, ${ms} ms`);
      this.flipLocked = flip;
      this.applyPose(worldFromCamera.clone().multiply(pose.cameraFromMural));
      return;
    }
    this.setStatus('last try', `${d.name} flip=${flip}: ${featurePoints.length} features, no match (${w}×${h})`);
  }

  private applyPose(worldFromMural: THREE.Matrix4): void {
    if (!this.placed) {
      this.contentGroup.matrix.copy(worldFromMural);
      this.contentGroup.matrixWorldNeedsUpdate = true;
      this.contentGroup.visible = true;
      this.placed = true;
      this.snapViewAngle = true;
      this.setStatus('mural', 'placed');
      this.options.onTargetFound?.();
      return;
    }

    const p0 = new THREE.Vector3(), q0 = new THREE.Quaternion(), s0 = new THREE.Vector3();
    const p1 = new THREE.Vector3(), q1 = new THREE.Quaternion(), s1 = new THREE.Vector3();
    this.contentGroup.matrix.decompose(p0, q0, s0);
    worldFromMural.decompose(p1, q1, s1);

    if (p0.distanceTo(p1) > REFINE_MAX_JUMP) {
      // One odd match shouldn't move the mural; several in a row mean it really moved.
      if (++this.disagreements < REFINE_REPLACE_AFTER) return;
      this.contentGroup.matrix.copy(worldFromMural);
    } else {
      p0.lerp(p1, REFINE_BLEND);
      q0.slerp(q1, REFINE_BLEND);
      this.contentGroup.matrix.compose(p0, q0, s0);
    }
    this.disagreements = 0;
    this.contentGroup.matrixWorldNeedsUpdate = true;
  }

  private updateViewAngle(time: number, view: XRView): void {
    const dt = this.lastFrameTime ? Math.min((time - this.lastFrameTime) / 1000, 0.1) : 0;
    this.lastFrameTime = time;
    if (!this.options.onViewAngle) return;

    this.contentGroup.updateMatrixWorld();
    const p = view.transform.position;
    const local = this.contentGroup.worldToLocal(new THREE.Vector3(p.x, p.y, p.z));
    if (local.z <= 0.01) return;
    const clamp = (v: number) => Math.max(-MAX_VIEW_TANGENT, Math.min(MAX_VIEW_TANGENT, v));
    const tanX = clamp(local.x / local.z);
    const tanY = clamp(local.y / local.z);
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

  /** Match the layers to the scene light using the camera image where the mural is. */
  private sampleLight(time: number, projection: number[], worldFromCamera: THREE.Matrix4): void {
    if (!this.placed || !this.options.onLight || time - this.lastLightSample < LIGHT_SAMPLE_INTERVAL) return;
    this.lastLightSample = time;
    const reader = this.reader!;
    const ar = this.options.aspectRatio;
    const hw = 0.5 * LIGHT_SAMPLE_REGION;
    const hh = (0.5 / ar) * LIGHT_SAMPLE_REGION;
    const cameraFromWorld = worldFromCamera.clone().invert();
    const P = new THREE.Matrix4().fromArray(projection);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    this.contentGroup.updateMatrixWorld();
    for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
      const c = new THREE.Vector3(x, y, 0).applyMatrix4(this.contentGroup.matrixWorld).applyMatrix4(cameraFromWorld);
      if (c.z >= 0) return; // behind the camera
      c.applyMatrix4(P);
      const px = ((c.x + 1) / 2) * reader.width;
      const py = ((1 - c.y) / 2) * reader.height;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    const x0 = Math.max(minX, 0), y0 = Math.max(minY, 0);
    const x1 = Math.min(maxX, reader.width), y1 = Math.min(maxY, reader.height);
    const light = this.lightEstimator.sample(reader.canvas, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    if (light) this.options.onLight(light[0], light[1], light[2]);
  }

  private handleEnd(): void {
    if (this.ended) return;
    this.ended = true;
    this.renderer.setAnimationLoop(null);
    document.documentElement.classList.remove('xr-session');
    this.options.onEnded?.();
  }

  stop(): void {
    const session = this.session;
    this.ended = true;
    this.renderer.setAnimationLoop(null);
    document.documentElement.classList.remove('xr-session');
    if (session) session.end().catch(() => undefined);
    this.session = null;
    this.reader?.dispose();
    this.depth?.dispose();
    for (const d of this.detectors) (d.controller as unknown as { dispose?: () => void } | null)?.dispose?.();
    this.hud?.remove();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
