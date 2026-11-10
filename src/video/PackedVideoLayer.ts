/**
 * PackedVideoLayer
 *
 * Creates a Three.js plane mesh that renders a packed video (RGB + luma alpha)
 * using a custom GLSL shader. Robust against video loading delays, iOS gesture
 * restrictions, and local origin handling.
 *
 * Geometry & Coordinate System
 * ────────────────────────────
 * MindAR normalises the anchor group so that the tracked target image maps to:
 *   width  = 1   (in Three.js world units)
 *   height = 1 / targetAspectRatio
 *
 * A PlaneGeometry(1, 1) at scale(1, 1) therefore fills the FULL WIDTH of the
 * target. We set scaleY = 1 / targetAspectRatio so the plane covers the
 * target height exactly.
 *
 * Position transform:
 *   Normalized mural top-left (0, 0) to bottom-right (1, 1) is converted to
 *   Three.js anchor center-space where (0, 0) is the target center,
 *   +X is right, and +Y is up.
 *
 * Parallax depth:
 *   Every layer stays on the wall plane, so tracking jitter moves all layers
 *   together, exactly like the painted mural. A layer's `depth` is simulated
 *   instead by sliding its texture inside its own frame according to the
 *   (smoothed) viewing angle: a layer `depth` in front of the wall seen at
 *   view tangent t appears displaced by -depth * t. Sampling is clamped, so
 *   content touching the frame edge stretches slightly instead of leaving a
 *   blank strip.
 *
 * Relief:
 *   With a depth map (a third "depth" band in the packed video, or a separate
 *   grayscale image), each pixel uses its own distance from the wall
 *   (depth + relief * map), so shapes look rounded instead of flat cut-outs.
 *
 * Wall look:
 *   A wall-fixed grain and a light multiplier sampled from the camera feed
 *   make the layers read as paint on the wall rather than a glowing screen.
 */

import * as THREE from 'three';
import type { LayerConfig } from '../config/types';
import vertexShader from './shaders/packed-alpha.vert.glsl?raw';
import fragmentShader from './shaders/packed-alpha.frag.glsl?raw';

/** Default alpha noise gate threshold below which fragments are discarded (kills video compression noise/trails). */
const DEFAULT_ALPHA_THRESHOLD = 0.06;

/** Default edge de-fringing strength (un-multiplies black halo at anti-aliased contour edges). */
const DEFAULT_DEFRINGE = 1.0;

/** Tiny per-layer Z offset that keeps coplanar layers from z-fighting. */
const LAYER_Z_EPSILON = 0.001;

/** Default relief depth (mural widths) for the white end of a layer's depth map. */
const DEFAULT_RELIEF = 0.03;

/** Default opacity of a popped-out layer's shadow on the wall. */
const DEFAULT_POP_SHADOW = 0.35;

/**
 * Shadow offset on the wall per unit of pop-out distance (light from the upper
 * left, as from a high sun). In mural widths per mural width of pop-out.
 */
const POP_SHADOW_OFFSET = new THREE.Vector2(0.35, -0.5);

/** Shadow blur radius in UV units per mural width of pop-out. */
const POP_SHADOW_BLUR = 0.06;

/** Seconds for one float cycle of a popped-out layer. */
const POP_FLOAT_PERIOD = 7;

/** Wall grain cells per mural width (roughly hand-sized patches on a 6 m wall). */
const GRAIN_SCALE = 40;

/** Options controlling depth and the wall look for a layer. */
export interface DepthOptions {
  /** Global multiplier applied to every layer's depth (for tuning on site). */
  depthScale?: number;
  /** Painted-wall grain strength for this mural (0 = off). */
  grain?: number;
  /** Viewer distance from the wall for lining up popped-out layers (mural widths). */
  viewDistance?: number;
  /** Viewer eye height above the bottom of the mural (mural widths). */
  eyeHeight?: number;
}

const DEFAULT_VIEW_DISTANCE = 1.5;
const DEFAULT_EYE_HEIGHT = 0.26;

export class PackedVideoLayer {
  public readonly mesh: THREE.Mesh;
  public readonly video: HTMLVideoElement;

  /** The layer's packed video texture (shared with effects such as the water overflow). */
  public readonly texture: THREE.Texture;
  private material: THREE.Material;
  private config: LayerConfig;
  private targetAspectRatio: number;
  private layerIndex: number;
  private depthScale: number;
  private viewDistance: number;
  private eyeHeight: number;
  private depthTexture: THREE.Texture | null = null;
  private isFallback = false;
  /** Shadow on the wall for a popped-out layer. */
  private shadowMesh: THREE.Mesh | null = null;
  private wallZ = 0;
  private shouldBePlaying = false;

  /** The layer's id from the mural config. */
  public get id(): string {
    return this.config.id;
  }

  /** Bands in the packed video: 2 (colour, alpha) or 3 (colour, alpha, depth). */
  public get bands(): number {
    return this.config.packing === 'color-alpha-depth' ? 3 : 2;
  }

  /**
   * @param config       Layer configuration (position, scale, blend, etc.)
   * @param basePath     Base URL path to resolve video src against
   * @param targetAR     Target image aspect ratio (width / height).
   *                     Defaults to 1 (square) if unspecified.
   * @param layerIndex   Index in layer stack for Z-ordering separation.
   * @param depthOptions Viewing distance and global depth multiplier for parallax.
   */
  constructor(
    config: LayerConfig,
    basePath: string,
    targetAR = 1,
    layerIndex = 0,
    depthOptions: DepthOptions = {},
  ) {
    this.config = config;
    this.targetAspectRatio = targetAR;
    this.layerIndex = layerIndex;
    this.depthScale = depthOptions.depthScale ?? 1;
    this.viewDistance = Math.max(depthOptions.viewDistance ?? DEFAULT_VIEW_DISTANCE, 0.2);
    this.eyeHeight = depthOptions.eyeHeight ?? DEFAULT_EYE_HEIGHT;

    const fullSrc = `${basePath}/${config.src}`;

    // --- Video element ---
    this.video = document.createElement('video');

    // Only set crossOrigin if URL is explicitly cross-domain
    if (fullSrc.startsWith('http://') || fullSrc.startsWith('https://')) {
      this.video.crossOrigin = 'anonymous';
    }

    this.video.src = fullSrc;
    this.video.loop = config.loop;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('webkit-playsinline', '');
    this.video.preload = 'auto';

    // Video texture
    const videoTexture = new THREE.VideoTexture(this.video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    videoTexture.format = THREE.RGBAFormat;
    this.texture = videoTexture;

    // Blend mode uniform value: 0 = normal, 1 = multiply, 2 = additive
    const blendModeVal = config.blendMode === 'multiply' ? 1 : config.blendMode === 'additive' ? 2 : 0;
    const alphaThreshold = config.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
    const defringe = config.defringe ?? DEFAULT_DEFRINGE;

    // Shader material
    const shaderMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTexture: { value: this.texture },
        uOpacity: { value: config.opacity },
        uAlphaThreshold: { value: alphaThreshold },
        uDefringe: { value: defringe },
        uBlendMode: { value: blendModeVal },
        uBands: { value: config.packing === 'color-alpha-depth' ? 3 : 2 },
        uDepthSource: { value: 0 },
        uDepthMap: { value: null },
        uViewTan: { value: new THREE.Vector2(0, 0) },
        uLayerDepth: { value: 0 },
        uRelief: { value: 0 },
        uLight: { value: new THREE.Vector3(1, 1, 1) },
        uGrain: { value: depthOptions.grain ?? 0 },
        uWallOrigin: { value: new THREE.Vector2(0, 0) },
        uWallSize: { value: new THREE.Vector2(1, 1) },
        uGrainScale: { value: GRAIN_SCALE },
        uShadow: { value: 0 },
        uShadowBlur: { value: 0 },
        uCropBottom: { value: config.cropBottom ?? 2 },
        uExtendBelow: { value: config.extendBelow ?? 2 },
      },
      vertexShader,
      fragmentShader,
    });

    if (config.blendMode === 'multiply') {
      shaderMaterial.blending = THREE.MultiplyBlending;
    } else if (config.blendMode === 'additive') {
      shaderMaterial.blending = THREE.AdditiveBlending;
    } else {
      shaderMaterial.blending = THREE.NormalBlending;
    }

    this.material = shaderMaterial;

    // Depth source for per-pixel relief: a packed depth band wins over a separate image.
    if (config.packing === 'color-alpha-depth') {
      shaderMaterial.uniforms.uDepthSource.value = 1;
    } else if (config.depthMap) {
      this.depthTexture = new THREE.TextureLoader().load(
        `${basePath}/${config.depthMap}`,
        () => {
          shaderMaterial.uniforms.uDepthSource.value = 2;
        },
        undefined,
        (err) => console.warn(`[PackedVideoLayer] Depth map ${config.depthMap} failed to load:`, err),
      );
      this.depthTexture.minFilter = THREE.LinearFilter;
      this.depthTexture.magFilter = THREE.LinearFilter;
      shaderMaterial.uniforms.uDepthMap.value = this.depthTexture;
    }
    this.updateDepthUniforms();

    // Plane geometry (1:1 normalized canvas)
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.renderOrder = layerIndex;

    // Popped-out layers stand in front of the wall and cast a soft shadow on it.
    if ((config.popOut ?? 0) > 0) {
      const shadowMaterial = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        // Same uniform objects, so light and video updates apply to both.
        uniforms: {
          ...shaderMaterial.uniforms,
          uShadow: { value: Math.min(Math.max(config.popShadow ?? DEFAULT_POP_SHADOW, 0), 1) },
          uShadowBlur: { value: 0 },
        },
        vertexShader,
        fragmentShader,
      });
      this.shadowMesh = new THREE.Mesh(geometry, shadowMaterial);
      this.shadowMesh.renderOrder = layerIndex - 0.5;
      this.mesh.add(this.shadowMesh);
      this.mesh.onBeforeRender = () => this.updatePopOut();
    }

    // Apply layer transforms
    this.applyTransforms();

    // Event listeners for robust video playback
    this.video.addEventListener('loadeddata', () => {
      console.log(`[PackedVideoLayer] Video loaded data: ${config.src}`);
      if (this.shouldBePlaying && this.video.paused) {
        this.attemptPlay();
      }
    });

    this.video.addEventListener('canplay', () => {
      if (this.shouldBePlaying && this.video.paused) {
        this.attemptPlay();
      }
    });

    // Handle video load errors by switching to procedural fallback
    this.video.onerror = (e) => {
      console.warn(`[PackedVideoLayer] Video ${config.src} load error:`, e, this.video.error);
      this.useFallbackTexture();
    };
  }

  /** Update the target aspect ratio and recalculate transforms. */
  public updateAspectRatio(newAR: number): void {
    if (newAR > 0 && Math.abs(this.targetAspectRatio - newAR) > 0.001) {
      this.targetAspectRatio = newAR;
      this.applyTransforms();
    }
  }

  /** Generate procedural fallback texture when MP4 file is missing or corrupted. */
  private useFallbackTexture(): void {
    if (this.isFallback) return;
    this.isFallback = true;

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;

    // Translucent dark background with cyan border & corner ticks
    ctx.fillStyle = 'rgba(15, 23, 42, 0.45)';
    ctx.fillRect(0, 0, 512, 512);

    // Glowing cyan outline
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 8;
    ctx.strokeRect(16, 16, 480, 480);

    // Corner brackets
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 16;
    const len = 60;

    // Top-left
    ctx.beginPath(); ctx.moveTo(16, 16 + len); ctx.lineTo(16, 16); ctx.lineTo(16 + len, 16); ctx.stroke();
    // Top-right
    ctx.beginPath(); ctx.moveTo(496 - len, 16); ctx.lineTo(496, 16); ctx.lineTo(496, 16 + len); ctx.stroke();
    // Bottom-left
    ctx.beginPath(); ctx.moveTo(16, 496 - len); ctx.lineTo(16, 496); ctx.lineTo(16 + len, 496); ctx.stroke();
    // Bottom-right
    ctx.beginPath(); ctx.moveTo(496 - len, 496); ctx.lineTo(496, 496); ctx.lineTo(496, 496 - len); ctx.stroke();

    // Text label
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('MURAL TRACKED', 256, 230);

    ctx.fillStyle = '#38bdf8';
    ctx.font = '22px sans-serif';
    ctx.fillText(`Layer: ${this.config.id}`, 256, 280);

    const canvasTexture = new THREE.CanvasTexture(canvas);
    canvasTexture.colorSpace = THREE.SRGBColorSpace;

    // Replace material with BasicMaterial for fallback
    this.mesh.material = new THREE.MeshBasicMaterial({
      map: canvasTexture,
      transparent: true,
      opacity: this.config.opacity,
      side: THREE.DoubleSide,
    });
  }

  /**
   * Apply position, scale, and rotation transforms.
   *
   * MindAR anchor space:
   *   x ∈ [-0.5 … +0.5]   (width  = 1)
   *   y ∈ [-h/2 … +h/2]   (height = 1 / targetAspectRatio)
   *
   * A PlaneGeometry(1, 1) fills width=1, height=1.
   * We scale Y by (1 / targetAR) so the plane matches the physical target height.
   * Then config's position (0..1) maps to the target coordinate space.
   */
  public applyTransforms(): void {
    const { position, scale, rotation } = this.config;
    const ar = this.targetAspectRatio;

    let width = scale[0];
    let height = scale[1] / ar;

    // Convert from mural top-left space (0..1) to Three.js center space
    // Center in mural space:
    const centerX = position[0] + scale[0] / 2;
    const centerY = position[1] + scale[1] / 2;

    let posX = centerX - 0.5;
    let posY = (0.5 - centerY) / ar;
    const posZ = this.layerIndex * LAYER_Z_EPSILON;
    this.wallZ = posZ;

    // A layer standing out from the wall is shrunk toward the typical viewer's
    // eye, so from there it exactly covers its painting and only separates
    // from it (in true 3D) as the viewer moves.
    const pop = this.basePop();
    if (pop > 0) {
      const k = Math.max((this.viewDistance - pop) / this.viewDistance, 0.2);
      const eyeY = -0.5 / ar + this.eyeHeight;
      posX *= k;
      posY = eyeY + (posY - eyeY) * k;
      width *= k;
      height *= k;
    }

    this.mesh.scale.set(width, height, 1);

    this.mesh.position.set(posX, posY, posZ + this.popDistance());
    this.mesh.rotation.z = -(rotation * Math.PI) / 180;

    if (this.material instanceof THREE.ShaderMaterial) {
      (this.material.uniforms.uWallOrigin.value as THREE.Vector2).set(posX, posY);
      (this.material.uniforms.uWallSize.value as THREE.Vector2).set(width, height);
    }
  }

  /** Current distance of a popped-out layer in front of the wall (mural widths). */
  private basePop(): number {
    return Math.max(this.config.popOut ?? 0, 0) * this.depthScale;
  }

  /** How far the layer stands out from the wall, without the float (mural widths). */
  public get popOut(): number {
    return this.basePop();
  }

  private popDistance(): number {
    const pop = this.basePop();
    if (pop === 0) return 0;
    const amp = Math.max(this.config.popFloat ?? 0, 0) * this.depthScale;
    const t = performance.now() / 1000;
    return Math.max(pop + amp * Math.sin((2 * Math.PI * t) / POP_FLOAT_PERIOD), 0.001);
  }

  /** Move a popped-out layer (float) and keep its shadow on the wall, offset by the light. */
  private updatePopOut(): void {
    const pop = this.popDistance();
    this.mesh.position.z = this.wallZ + pop;
    if (!this.shadowMesh) return;
    const sx = this.mesh.scale.x || 1;
    const sy = this.mesh.scale.y || 1;
    this.shadowMesh.position.set((POP_SHADOW_OFFSET.x * pop) / sx, (POP_SHADOW_OFFSET.y * pop) / sy, -pop + 0.0005);
    const mat = this.shadowMesh.material as THREE.ShaderMaterial;
    mat.uniforms.uShadowBlur.value = (POP_SHADOW_BLUR * pop) / Math.max(sx, sy);
  }

  /** Push the layer's depth and relief (scaled by the global depth multiplier) to the shader. */
  private updateDepthUniforms(): void {
    if (!(this.material instanceof THREE.ShaderMaterial)) return;
    const hasDepthSource = this.config.packing === 'color-alpha-depth' || !!this.config.depthMap;
    const relief = hasDepthSource ? Math.max(this.config.relief ?? DEFAULT_RELIEF, 0) : 0;
    // A popped-out layer gets its parallax from its real position instead.
    const depth = (this.config.popOut ?? 0) > 0 ? 0 : Math.max(this.config.depth ?? 0, 0);
    this.material.uniforms.uLayerDepth.value = depth * this.depthScale;
    this.material.uniforms.uRelief.value = relief * this.depthScale;
  }

  /**
   * Update the parallax offset from the current view direction.
   *
   * @param tanX Horizontal view tangent (camera x / camera distance) in anchor space.
   * @param tanY Vertical view tangent (camera y / camera distance) in anchor space.
   */
  public setParallax(tanX: number, tanY: number): void {
    if (!(this.material instanceof THREE.ShaderMaterial)) return;

    // Content at distance d from the wall appears displaced by -d * tan on the wall,
    // so we sample the texture at +d * tan (in UV units). Rotate into the layer's
    // local frame (mesh is rotated by -rotation) and divide by its size.
    const r = (this.config.rotation * Math.PI) / 180;
    const localX = tanX * Math.cos(r) - tanY * Math.sin(r);
    const localY = tanX * Math.sin(r) + tanY * Math.cos(r);
    (this.material.uniforms.uViewTan.value as THREE.Vector2).set(
      localX / this.mesh.scale.x,
      localY / this.mesh.scale.y,
    );
  }

  /**
   * Match the layer to the scene lighting.
   * @param light Per-channel multiplier (1 = as authored).
   */
  public setLight(r: number, g: number, b: number): void {
    if (!(this.material instanceof THREE.ShaderMaterial)) return;
    (this.material.uniforms.uLight.value as THREE.Vector3).set(r, g, b);
  }

  private async attemptPlay(): Promise<void> {
    try {
      await this.video.play();
      console.log(`[PackedVideoLayer] Successfully playing: ${this.config.src}`);
    } catch (err) {
      console.warn(`[PackedVideoLayer] Playback deferred for ${this.config.src}:`, err);
      // Attach one-time window touch handler to resume playback on next tap
      const tapHandler = () => {
        if (this.shouldBePlaying && this.video.paused) {
          this.video.play().catch(() => {});
        }
      };
      window.addEventListener('touchstart', tapHandler, { once: true });
      window.addEventListener('click', tapHandler, { once: true });
    }
  }

  async play(): Promise<void> {
    this.shouldBePlaying = true;
    if (this.isFallback) return;
    await this.attemptPlay();
  }

  pause(): void {
    this.shouldBePlaying = false;
    if (!this.isFallback) {
      this.video.pause();
    }
  }

  setAlphaThreshold(value: number): void {
    if (this.material instanceof THREE.ShaderMaterial) {
      this.material.uniforms.uAlphaThreshold.value = value;
    }
  }

  setDefringe(value: number): void {
    if (this.material instanceof THREE.ShaderMaterial) {
      this.material.uniforms.uDefringe.value = value;
    }
  }

  setOpacity(value: number): void {
    if (this.material instanceof THREE.ShaderMaterial) {
      this.material.uniforms.uOpacity.value = value;
    } else if (this.material instanceof THREE.MeshBasicMaterial) {
      this.material.opacity = value;
    }
  }

  dispose(): void {
    this.shouldBePlaying = false;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();

    this.texture.dispose();
    this.depthTexture?.dispose();
    this.material.dispose();
    (this.shadowMesh?.material as THREE.Material | undefined)?.dispose();
    this.mesh.geometry.dispose();
  }
}
