/**
 * PeopleMask
 *
 * Keeps a soft mask of the people in the camera image, for hiding the AR
 * layers where someone stands in front of the wall. Detection runs in a
 * worker a few times a second; the mask is a texture in camera-video space
 * that the layer shader looks up per pixel (see `occluderMap`).
 */

import * as THREE from 'three';
import type { PeopleFrame, PeopleRequest, PeopleResponse } from './people.worker';

/** Minimum time (ms) between frames sent for detection. */
const UPDATE_INTERVAL = 150;
/** Longest side of the frame given to the detector (it works at 320 px internally). */
const FRAME_SIZE = 640;
/** Longest side of the mask texture. */
const MASK_SIZE = 256;
/** A mask older than this (ms) is faded out, so a stalled worker can't leave holes behind. */
const MASK_MAX_AGE = 4000;

export interface PeopleMaskOptions {
  detectorModel?: string;
  segmenterModel?: string;
}

export class PeopleMask {
  /** Mask texture: white where a person is, in camera-video space (top row first). */
  public readonly texture: THREE.CanvasTexture;
  /**
   * Maps gl_FragCoord.xy (drawing-buffer pixels) to mask UV:
   * uv = fragCoord * (x, y) + (z, w). Shared with every layer's material.
   */
  public readonly occluderMap = new THREE.Vector4(0, 0, 0, 0);
  /** 0..1 strength of the occlusion; 0 while no fresh mask is available. */
  public strength = 0;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private worker: Worker | null = null;
  private ready = false;
  private busy = false;
  private lastSent = 0;
  private lastMask = 0;
  private hasPeople = false;
  private failed = false;
  /** Log detection results (enable with ?debug=people). */
  private readonly debug = new URLSearchParams(location.search).get('debug') === 'people';

  private readonly options: PeopleMaskOptions;

  constructor(options: PeopleMaskOptions = {}) {
    this.options = options;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 1;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.flipY = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    if (this.debug) (window as unknown as { peopleMask: PeopleMask }).peopleMask = this;
  }

  /** Load the models in the background. Tracking does not wait for this. */
  start(): void {
    if (this.worker || this.failed) return;
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
      console.warn('[PeopleMask] OffscreenCanvas not supported; people occlusion disabled');
      this.failed = true;
      return;
    }
    try {
      this.worker = new Worker(new URL('./people.worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      console.warn('[PeopleMask] Worker failed to start; people occlusion disabled', err);
      this.failed = true;
      return;
    }
    this.worker.onmessage = (e: MessageEvent<PeopleResponse>) => this.handleMessage(e.data);
    this.worker.onerror = (e) => {
      console.warn('[PeopleMask] Worker error; people occlusion disabled', e.message);
      this.stop();
      this.failed = true;
    };
    const init: PeopleRequest = {
      type: 'init',
      detectorModel: new URL(this.options.detectorModel ?? '/models/efficientdet_lite0.tflite', location.href).href,
      segmenterModel: new URL(this.options.segmenterModel ?? '/models/selfie_segmenter.tflite', location.href).href,
    };
    this.worker.postMessage(init);
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.busy = false;
    this.strength = 0;
  }

  dispose(): void {
    this.stop();
    this.texture.dispose();
  }

  /**
   * Call every frame while the mural is tracked. Sends a new camera frame for
   * detection when the worker is free, and keeps the screen → mask mapping
   * up to date (the video is scaled to cover the screen, so the mapping
   * depends on the layout).
   */
  update(time: number, video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
    this.updateMapping(video, canvas);

    const age = time - this.lastMask;
    this.strength = this.hasPeople && age < MASK_MAX_AGE ? 1 : 0;

    if (!this.ready || this.busy || time - this.lastSent < UPDATE_INTERVAL) return;
    if (video.readyState < 2 || !video.videoWidth) return;
    this.lastSent = time;
    this.busy = true;

    const scale = Math.min(1, FRAME_SIZE / Math.max(video.videoWidth, video.videoHeight));
    const fw = Math.round(video.videoWidth * scale);
    const fh = Math.round(video.videoHeight * scale);
    const ms = MASK_SIZE / Math.max(fw, fh);
    createImageBitmap(video, { resizeWidth: fw, resizeHeight: fh, resizeQuality: 'low' })
      .then((frame) => {
        if (!this.worker) {
          frame.close();
          return;
        }
        const msg: PeopleFrame = {
          type: 'frame',
          frame,
          maskWidth: Math.round(fw * ms),
          maskHeight: Math.round(fh * ms),
        };
        this.worker.postMessage(msg, [frame]);
      })
      .catch(() => {
        this.busy = false;
      });
  }

  private handleMessage(msg: PeopleResponse): void {
    if (msg.type === 'ready') {
      console.log('[PeopleMask] Ready');
      this.ready = true;
      return;
    }
    if (msg.type === 'error') {
      console.warn('[PeopleMask]', msg.message);
      this.busy = false;
      return;
    }
    this.busy = false;
    this.lastMask = performance.now();
    this.hasPeople = !!msg.mask;
    if (this.debug) console.log(`[PeopleMask] ${msg.people} people, ${msg.ms.toFixed(0)} ms`);
    if (!msg.mask || !this.ctx) return;

    if (this.canvas.width !== msg.mask.width || this.canvas.height !== msg.mask.height) {
      this.canvas.width = msg.mask.width;
      this.canvas.height = msg.mask.height;
      // WebGL2 textures have immutable storage; re-create the texture at the new size.
      this.texture.dispose();
    }
    this.ctx.drawImage(msg.mask, 0, 0);
    msg.mask.close();
    this.texture.needsUpdate = true;
  }

  /** gl_FragCoord (drawing-buffer pixels, origin bottom-left) → camera-video UV (origin top-left). */
  private updateMapping(video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
    const c = canvas.getBoundingClientRect();
    const v = video.getBoundingClientRect();
    if (!c.width || !c.height || !v.width || !v.height) return;
    const dprX = canvas.width / c.width;
    const dprY = canvas.height / c.height;
    // css x = fragX / dpr ; u = (c.left + cssX - v.left) / v.width
    // css y (from top) = c.height - fragY / dpr ; t = (c.top + cssY - v.top) / v.height
    this.occluderMap.set(
      1 / (dprX * v.width),
      -1 / (dprY * v.height),
      (c.left - v.left) / v.width,
      (c.top - v.top + c.height) / v.height,
    );
  }
}
