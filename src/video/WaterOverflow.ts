/**
 * WaterOverflow
 *
 * Breaks the "picture frame" of the wall: shortly after the mural starts
 * playing, the painted water spills out of the bottom of the mural onto the
 * ground in front of the wall.
 *
 * A horizontal plane sits at the foot of the wall (in the tracked mural's
 * space, so it follows the wall). Its shader reads the water layer's own
 * packed video, so the spill keeps the artist's colours and ripples, and an
 * animated outline grows out from the wall.
 *
 * Seen from eye height several metres back, the floor is at a grazing angle,
 * and a small pitch error in the image-tracking pose can put the phone "below"
 * the floor, hiding a flat plane. So the spill is hinged at the foot of the
 * wall and tips down just enough to always face the camera at a minimum
 * angle; when the phone is clearly above the floor it lies flat.
 */

import * as THREE from 'three';
import type { OverflowConfig } from '../config/types';
import type { PackedVideoLayer } from './PackedVideoLayer';
import vertexShader from './shaders/packed-alpha.vert.glsl?raw';
import fragmentShader from './shaders/water-overflow.frag.glsl?raw';

const DEFAULTS = {
  depth: 0.45,
  spread: 0.12,
  groundOffset: 0,
  delaySeconds: 1.5,
  revealSeconds: 4,
  opacity: 0.92,
  sourceTop: 0.8,
  minViewAngle: 14,
};

/** Most the spill tips down below flat (radians). */
const MAX_TILT = (50 * Math.PI) / 180;

export class WaterOverflow {
  /** Add this to the mural's content group. */
  public readonly object = new THREE.Group();
  public readonly mesh: THREE.Mesh;

  private material: THREE.ShaderMaterial;
  private settings: typeof DEFAULTS;
  /** Seconds the mural has been playing (only advances while playing). */
  private playTime = 0;
  private playing = false;
  private lastNow = 0;
  private tilt = 0;
  private readonly cameraLocal = new THREE.Vector3();

  constructor(config: OverflowConfig, source: PackedVideoLayer, aspectRatio: number) {
    this.settings = { ...DEFAULTS, ...config } as typeof DEFAULTS;
    const { depth, spread, groundOffset, opacity, sourceTop } = this.settings;
    const width = 1 + 2 * spread + 0.1;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTexture: { value: source.texture },
        uBands: { value: source.bands },
        uOpacity: { value: opacity },
        uLight: { value: new THREE.Vector3(1, 1, 1) },
        uSize: { value: new THREE.Vector2(width, depth) },
        uSpread: { value: spread },
        uSourceTop: { value: sourceTop },
        uReveal: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader,
      fragmentShader,
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), this.material);
    // Hinge at the foot of the wall; the plane lies flat out toward the viewer.
    // Starts under the water layer, wherever it stands from the wall.
    const bottom = source.popOut > 0
      ? source.mesh.position.y - source.mesh.scale.y / 2 // a popped-out layer is shrunk toward the viewer
      : -0.5 / aspectRatio;
    this.object.position.set(0, bottom - groundOffset, source.popOut);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.set(0, 0, depth / 2);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    this.mesh.onBeforeRender = (_r, _s, camera) => this.update(camera);
    this.object.add(this.mesh);
  }

  /** Start (or resume) the spill clock; called when the mural starts playing. */
  play(): void {
    if (!this.playing) this.lastNow = performance.now();
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  setLight(r: number, g: number, b: number): void {
    (this.material.uniforms.uLight.value as THREE.Vector3).set(r, g, b);
  }

  private update(camera: THREE.Camera): void {
    const now = performance.now();
    const dt = Math.min((now - this.lastNow) / 1000, 0.5);
    this.lastNow = now;

    // Tip the spill down until the camera sees it at least minViewAngle from edge-on.
    if (this.object.parent) {
      this.cameraLocal.setFromMatrixPosition(camera.matrixWorld);
      this.object.parent.worldToLocal(this.cameraLocal);
      const elevation = Math.atan2(this.cameraLocal.y - this.object.position.y, Math.max(this.cameraLocal.z, 1e-3));
      const want = Math.min(Math.max((this.settings.minViewAngle * Math.PI) / 180 - elevation, 0), MAX_TILT);
      this.tilt += (want - this.tilt) * (1 - Math.exp(-dt / 0.5)); // smooth out tracking jitter
      this.object.rotation.x = this.tilt;
    }

    if (this.playing) this.playTime += dt;
    const { delaySeconds, revealSeconds } = this.settings;
    const p = Math.min(Math.max((this.playTime - delaySeconds) / Math.max(revealSeconds, 0.01), 0), 1);
    // Fast at first, settling as it reaches its full extent.
    this.material.uniforms.uReveal.value = 1 - Math.pow(1 - p, 2.2);
    this.material.uniforms.uTime.value = now / 1000;
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
