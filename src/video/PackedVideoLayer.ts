/**
 * PackedVideoLayer
 *
 * Creates a Three.js plane mesh that renders a packed video (RGB + luma alpha)
 * using a custom GLSL shader. If video fails to load or is missing, renders an
 * elegant procedural AR fallback plane so tracking is immediately visible.
 */

import * as THREE from 'three';
import type { LayerConfig } from '../config/types';
import vertexShader from './shaders/packed-alpha.vert.glsl?raw';
import fragmentShader from './shaders/packed-alpha.frag.glsl?raw';

/** Default alpha threshold below which fragments are discarded. */
const DEFAULT_ALPHA_THRESHOLD = 0.01;

export class PackedVideoLayer {
  public readonly mesh: THREE.Mesh;
  public readonly video: HTMLVideoElement;

  private texture: THREE.Texture;
  private material: THREE.Material;
  private config: LayerConfig;
  private isFallback = false;

  constructor(config: LayerConfig, basePath: string) {
    this.config = config;

    // --- Video element ---
    this.video = document.createElement('video');
    this.video.src = `${basePath}/${config.src}`;
    this.video.crossOrigin = 'anonymous';
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

    // Shader material
    const shaderMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTexture: { value: this.texture },
        uOpacity: { value: config.opacity },
        uAlphaThreshold: { value: DEFAULT_ALPHA_THRESHOLD },
      },
      vertexShader,
      fragmentShader,
    });
    this.material = shaderMaterial;

    // Plane geometry (1:1 normalized canvas)
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.Mesh(geometry, this.material);

    // Apply layer transforms
    this.applyTransforms();

    // Handle video load errors by switching to procedural fallback
    this.video.onerror = () => {
      console.info(`[PackedVideoLayer] Video ${config.src} not found or failed to load. Using AR fallback visualization.`);
      this.useFallbackTexture();
    };
  }

  /** Generate procedural fallback texture when MP4 file is not present yet. */
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

  private applyTransforms(): void {
    const { position, scale, rotation } = this.config;

    this.mesh.scale.set(scale[0], scale[1], 1);

    // Convert from mural top-left space (0..1) to Three.js center space (-0.5..0.5, Y-up)
    const x = position[0] + (scale[0] / 2) - 0.5;
    const y = -(position[1] + (scale[1] / 2) - 0.5);
    this.mesh.position.set(x, y, 0);

    this.mesh.rotation.z = -(rotation * Math.PI) / 180;
  }

  async play(): Promise<void> {
    if (this.isFallback) return;
    try {
      await this.video.play();
    } catch (err) {
      // On iOS, play() can fail outside user gesture context.
      // Don't fall back — the video will start on next user tap.
      console.warn(`[PackedVideoLayer] Playback deferred for ${this.config.id}:`, err);
    }
  }

  pause(): void {
    if (!this.isFallback) {
      this.video.pause();
    }
  }

  setAlphaThreshold(value: number): void {
    if (this.material instanceof THREE.ShaderMaterial) {
      this.material.uniforms.uAlphaThreshold.value = value;
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
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();

    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
