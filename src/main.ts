/**
 * Mural WebAR — Main Entry Point
 *
 * Bootstraps the AR experience:
 *  1. Browser compatibility check
 *  2. Load mural configuration
 *  3. Wait for user tap (required by iOS for video autoplay)
 *  4. Initialize AR engine with MindAR + Three.js
 *  5. Add video layers to tracked anchor
 *  6. React to target detection / loss
 */

import './style.css';
import { AREngine } from './ar/AREngine';
import { Overlay } from './ui/Overlay';
import { PackedVideoLayer } from './video/PackedVideoLayer';
import type { MuralConfig } from './config/types';

/** Path to the mural config — can later be derived from the URL path. */
const MURAL_CONFIG_PATH = '/murals/mural-001/config.json';

function isBrowserSupported(): boolean {
  return typeof navigator.mediaDevices?.getUserMedia === 'function' && !!window.WebGLRenderingContext;
}

/**
 * Prime all video elements for iOS playback.
 * iOS Safari requires video.play() to be called within a user gesture.
 * We briefly play+pause each video to "unlock" it, then MindAR callbacks
 * can freely play/pause later without gesture restrictions.
 */
function primeVideosForIOS(layers: PackedVideoLayer[]): void {
  for (const layer of layers) {
    const v = layer.video;
    const playPromise = v.play();
    if (playPromise) {
      playPromise.then(() => {
        v.pause();
        v.currentTime = 0;
      }).catch(() => {
        // Still failed — will retry on target detection
      });
    }
  }
}

/**
 * Show a "Tap to Start" prompt and wait for a user tap.
 * Returns a Promise that resolves on the first touchstart/click.
 */
function waitForUserTap(overlay: Overlay): Promise<void> {
  overlay.show('tap-to-start');
  return new Promise((resolve) => {
    const handler = () => {
      document.removeEventListener('touchstart', handler);
      document.removeEventListener('click', handler);
      resolve();
    };
    document.addEventListener('touchstart', handler, { once: true });
    document.addEventListener('click', handler, { once: true });
  });
}

async function main(): Promise<void> {
  const overlay = new Overlay();

  if (!isBrowserSupported()) {
    overlay.show('unsupported');
    return;
  }

  overlay.show('loading');

  // Load mural configuration
  let config: MuralConfig;
  try {
    const res = await fetch(MURAL_CONFIG_PATH);
    if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
    config = await res.json();
  } catch (err) {
    console.error('[MuralAR] Failed to load mural config:', err);
    overlay.show('unsupported');
    return;
  }

  const basePath = MURAL_CONFIG_PATH.replace('/config.json', '');

  const container = document.getElementById('ar-container');
  if (!container) {
    console.error('[MuralAR] #ar-container not found');
    return;
  }

  // Wait for user tap — required on iOS for video autoplay permissions
  await waitForUserTap(overlay);

  overlay.show('loading');

  let layers: PackedVideoLayer[] = [];

  // Initialize AR Engine
  let engine: AREngine;
  try {
    engine = new AREngine({
      container,
      targetSrc: `${basePath}/${config.target}`,
      onTargetFound: () => {
        console.log('[MuralAR] Target found!');
        overlay.hide();
        layers.forEach((layer) => layer.play());
      },
      onTargetLost: () => {
        console.log('[MuralAR] Target lost');
        overlay.show('tracking-lost');
        layers.forEach((layer) => layer.pause());
      },
    });

    // Create and attach layers to anchor group upfront with explicit depth renderOrder
    layers = config.layers.map((layerConfig, index) => {
      const layer = new PackedVideoLayer(layerConfig, basePath);
      layer.mesh.renderOrder = index;
      engine.anchorGroup.add(layer.mesh);
      return layer;
    });

    // Prime videos within user gesture context (iOS requirement)
    primeVideosForIOS(layers);

  } catch (err) {
    console.error('[MuralAR] Failed to initialize AR engine:', err);
    overlay.show('unsupported');
    return;
  }

  // Start AR session
  overlay.show('scanning');

  try {
    await engine.start();
  } catch (err) {
    console.error('[MuralAR] Failed to start AR:', err);
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      overlay.show('camera-denied');
    } else {
      overlay.show('unsupported');
    }
  }
}

main().catch(console.error);
