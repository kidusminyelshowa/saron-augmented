/**
 * DepthOcclusion
 *
 * Feeds the phone's real-world depth (WebXR depth sensing, from ARCore) to the
 * layer shaders, so the animation is hidden wherever something real is
 * closer to the camera than the wall: people, poles, cars, scaffolding.
 *
 * Uses the CPU-optimised depth data (the most widely supported form on
 * Android Chrome): a small depth image per frame that is uploaded as a texture.
 */

import * as THREE from 'three';

/** Minimal typings for the WebXR depth-sensing API (not in the DOM lib yet). */
interface CPUDepthInformation {
  readonly data: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly rawValueToMeters: number;
  readonly normDepthBufferFromNormView: { matrix: Float32Array };
}

export class DepthOcclusion {
  /** Uniforms shared by every layer material (see PackedVideoLayer.setDepthOccluder). */
  public readonly uniforms = {
    uDepthMode: { value: 0 },
    uSceneDepth: { value: null as THREE.Texture | null },
    uSceneDepthUv: { value: new THREE.Matrix4() },
    uSceneDepthScale: { value: 0.001 },
    uViewportInv: { value: new THREE.Vector2(1, 1) },
  };

  private texture: THREE.DataTexture | null = null;
  private format: 'luminance-alpha' | 'float32' = 'luminance-alpha';
  /** Frames since depth was last available; occlusion turns off when it goes stale. */
  private missing = 0;

  private readonly session: XRSession;
  private usage: string | null = null;

  constructor(session: XRSession) {
    this.session = session;
    // Reading these throws when depth sensing wasn't granted.
    try {
      const s = session as unknown as { depthUsage?: string; depthDataFormat?: string };
      this.usage = s.depthUsage ?? null;
      if (s.depthDataFormat === 'float32') this.format = 'float32';
    } catch {
      this.usage = null;
    }
  }

  /** True when the session granted CPU depth data. */
  get available(): boolean {
    const features = (this.session as unknown as { enabledFeatures?: string[] }).enabledFeatures;
    if (features && !features.includes('depth-sensing')) return false;
    return this.usage === 'cpu-optimized';
  }

  /** Call once per XR frame with the (single) view and the framebuffer size. */
  update(frame: XRFrame, view: XRView, framebufferWidth: number, framebufferHeight: number): void {
    if (!this.available) return;
    let info: CPUDepthInformation | null = null;
    try {
      info = (frame as unknown as { getDepthInformation(v: XRView): CPUDepthInformation | null }).getDepthInformation(view);
    } catch {
      info = null;
    }
    if (!info) {
      if (++this.missing > 10) this.uniforms.uDepthMode.value = 0;
      return;
    }
    this.missing = 0;

    const { width, height } = info;
    // The data is only valid during this frame, so copy it.
    const data = this.format === 'float32'
      ? new Float32Array(info.data.slice(0))
      : new Uint8Array(info.data.slice(0));

    if (!this.texture || this.texture.image.width !== width || this.texture.image.height !== height) {
      this.texture?.dispose();
      this.texture = this.format === 'float32'
        ? new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.FloatType)
        : new THREE.DataTexture(data, width, height, THREE.RGFormat, THREE.UnsignedByteType);
      // Nearest: 16-bit values split over two bytes can't be interpolated, and
      // float textures can't be filtered everywhere.
      this.texture.magFilter = THREE.NearestFilter;
      this.texture.minFilter = THREE.NearestFilter;
      this.texture.generateMipmaps = false;
      this.texture.flipY = false;
      this.texture.unpackAlignment = 1;
      this.uniforms.uSceneDepth.value = this.texture;
    } else {
      this.texture.image.data = data as unknown as Uint8Array;
    }
    this.texture.needsUpdate = true;

    this.uniforms.uSceneDepthUv.value.fromArray(info.normDepthBufferFromNormView.matrix);
    this.uniforms.uSceneDepthScale.value = info.rawValueToMeters;
    this.uniforms.uViewportInv.value.set(1 / framebufferWidth, 1 / framebufferHeight);
    this.uniforms.uDepthMode.value = this.format === 'float32' ? 2 : 1;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
    this.uniforms.uDepthMode.value = 0;
  }
}
