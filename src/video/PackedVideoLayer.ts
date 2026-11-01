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

/** Options controlling how a layer's depth is turned into parallax. */
export interface DepthOptions {
  /** Global multiplier applied to every layer's depth (for tuning on site). */
  depthScale?: number;
}

export class PackedVideoLayer {
  public readonly mesh: THREE.Mesh;
  public readonly video: HTMLVideoElement;

  private texture: THREE.Texture;
  private material: THREE.Material;
  private config: LayerConfig;
  private targetAspectRatio: number;
  private layerIndex: number;
  private depthScale: number;
  private isFallback = false;
  private shouldBePlaying = false;

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
        uParallax: { value: new THREE.Vector2(0, 0) },
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

    // Plane geometry (1:1 normalized canvas)
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.renderOrder = layerIndex;

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

    const width = scale[0];
    const height = scale[1] / ar;

    this.mesh.scale.set(width, height, 1);

    // Convert from mural top-left space (0..1) to Three.js center space
    // Center in mural space:
    const centerX = position[0] + scale[0] / 2;
    const centerY = position[1] + scale[1] / 2;

    const posX = centerX - 0.5;
    const posY = (0.5 - centerY) / ar;
    const posZ = this.layerIndex * LAYER_Z_EPSILON;

    this.mesh.position.set(posX, posY, posZ);
    this.mesh.rotation.z = -(rotation * Math.PI) / 180;
  }

  /**
   * Update the parallax offset from the current view direction.
   *
   * @param tanX Horizontal view tangent (camera x / camera distance) in anchor space.
   * @param tanY Vertical view tangent (camera y / camera distance) in anchor space.
   */
  public setParallax(tanX: number, tanY: number): void {
    if (!(this.material instanceof THREE.ShaderMaterial)) return;
    const depth = Math.max(this.config.depth ?? 0, 0) * this.depthScale;
    const uniform = this.material.uniforms.uParallax.value as THREE.Vector2;
    if (depth === 0) {
      uniform.set(0, 0);
      return;
    }

    // Apparent displacement on the wall, in anchor units.
    const shiftX = -depth * tanX;
    const shiftY = -depth * tanY;

    // Rotate into the layer's local frame (mesh is rotated by -rotation).
    const r = (this.config.rotation * Math.PI) / 180;
    const localX = shiftX * Math.cos(r) - shiftY * Math.sin(r);
    const localY = shiftX * Math.sin(r) + shiftY * Math.cos(r);

    // Convert to UV units of this layer's plane.
    uniform.set(localX / this.mesh.scale.x, localY / this.mesh.scale.y);
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
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
