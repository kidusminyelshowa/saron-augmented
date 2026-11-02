/**
 * Mural WebAR — Main Entry Point
 *
 * Bootstraps the AR experience:
 *  1. Browser compatibility check
 *  2. Load mural catalog & active mural configuration
 *  3. Render Mural Selection UI selector
 *  4. Wait for user tap (required by iOS for video autoplay)
 *  5. Initialize AR engine with MindAR + Three.js
 *  6. React to target detection / loss & handle dynamic mural switching
 */

import './style.css';
import { AREngine } from './ar/AREngine';
import { XREngine } from './xr/XREngine';
import { Overlay } from './ui/Overlay';
import { MuralSelector, type MuralItem } from './ui/MuralSelector';
import { PackedVideoLayer } from './video/PackedVideoLayer';
import type { MuralConfig } from './config/types';

/** Default strength of matching layers to the camera's lighting (0–1). */
const DEFAULT_LIGHT_MATCH = 0.8;

/** Default painted-wall grain strength (0–1). */
const DEFAULT_WALL_GRAIN = 0.12;

function isBrowserSupported(): boolean {
  return typeof navigator.mediaDevices?.getUserMedia === 'function' && !!window.WebGLRenderingContext;
}

/**
 * Optional `?depth=<n>` URL parameter that multiplies every layer's depth.
 * Lets the parallax strength be tuned in front of the wall without a redeploy
 * (e.g. ?depth=0 for flat, ?depth=2 for double depth).
 */
function getDepthScaleOverride(): number | undefined {
  const raw = new URLSearchParams(window.location.search).get('depth');
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** People occlusion is on unless the mural config or `?occlusion=0` turns it off. */
function isOcclusionEnabled(config: MuralConfig): boolean {
  const raw = new URLSearchParams(window.location.search).get('occlusion');
  if (raw !== null) return raw !== '0' && raw !== 'false';
  return config.wall?.occludePeople ?? true;
}

/** The Android scene-tracking mode can be turned off for a visit with `?xr=0`. */
function isXRAllowed(): boolean {
  const raw = new URLSearchParams(window.location.search).get('xr');
  return raw !== '0' && raw !== 'false';
}

/**
 * Prime all video elements for iOS playback.
 * iOS Safari requires video.play() to be called within a user gesture.
 */
function primeVideosForIOS(layers: PackedVideoLayer[]): void {
  for (const layer of layers) {
    const v = layer.video;
    const playPromise = v.play();
    if (playPromise) {
      playPromise
        .then(() => {
          v.pause();
          v.currentTime = 0;
        })
        .catch(() => {
          // Still failed — will retry on target detection
        });
    }
  }
}

/**
 * Show a "Tap to Start" prompt and wait for user tap.
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

  // Fetch mural index catalog
  let murals: MuralItem[] = [];
  try {
    const catalogRes = await fetch('/murals/index.json');
    if (catalogRes.ok) {
      murals = await catalogRes.json();
    }
  } catch (err) {
    console.warn('[MuralAR] Catalog fetch failed, falling back to default:', err);
  }

  if (murals.length === 0) {
    murals = [
      { id: 'mural-001', name: 'Alliance Mural' },
      { id: 'mural-002', name: 'National Cement Mural' },
    ];
  }

  // Get active mural ID from URL search params or default to mural-001
  const urlParams = new URLSearchParams(window.location.search);
  let activeMuralId = urlParams.get('mural') || murals[0].id;
  if (!murals.some((m) => m.id === activeMuralId)) {
    activeMuralId = murals[0].id;
  }

  const container = document.getElementById('ar-container');
  if (!container) {
    console.error('[MuralAR] #ar-container not found');
    return;
  }

  let currentEngine: AREngine | XREngine | null = null;
  let currentLayers: PackedVideoLayer[] = [];
  let userHasTapped = false;

  // Render Mural Selector UI
  const selector = new MuralSelector({
    murals,
    activeMuralId,
    onSelect: (newMuralId) => {
      switchMural(newMuralId);
    },
  });

  async function startMuralSession(muralId: string): Promise<void> {
    overlay.show('loading');

    // Clean up previous engine & layers
    if (currentEngine) {
      currentEngine.stop();
      currentEngine = null;
    }
    currentLayers.forEach((layer) => layer.dispose());
    currentLayers = [];
    container!.innerHTML = '';

    // Update URL parameter without page reload
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('mural', muralId);
    window.history.replaceState(null, '', newUrl.toString());

    // Load mural config
    const configPath = `/murals/${muralId}/config.json`;
    let config: MuralConfig;
    try {
      const res = await fetch(configPath);
      if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
      config = await res.json();
    } catch (err) {
      console.error(`[MuralAR] Failed to load config for ${muralId}:`, err);
      overlay.show('unsupported');
      return;
    }

    const basePath = `/murals/${muralId}`;

    // Android Chrome with ARCore: scene tracking + depth (checked before the tap,
    // because starting the session must follow the tap closely).
    const useXR = !!config.xr && isXRAllowed() && (await XREngine.isSupported());

    // Prompt user tap (needed for camera, video playback on iOS and the AR session)
    if (!userHasTapped) {
      await waitForUserTap(overlay);
      userHasTapped = true;
    }

    overlay.show('loading');

    const callbacks = {
      onTargetFound: () => {
        console.log(`[MuralAR] Target found for ${muralId}!`);
        overlay.hide();
        currentLayers.forEach((layer) => layer.play());
      },
      onTargetLost: () => {
        console.log(`[MuralAR] Target lost for ${muralId}`);
        overlay.show('tracking-lost');
        currentLayers.forEach((layer) => layer.pause());
      },
      onViewAngle: (tanX: number, tanY: number) => {
        currentLayers.forEach((layer) => layer.setParallax(tanX, tanY));
      },
      onLight: (r: number, g: number, b: number) => {
        currentLayers.forEach((layer) => layer.setLight(r, g, b));
      },
      light: {
        reference: config.wall?.reference,
        strength: config.wall?.lightMatch ?? DEFAULT_LIGHT_MATCH,
      },
    };

    try {
      let engine: AREngine | XREngine | null = null;

      if (useXR) {
        const xrEngine = new XREngine({
          ...callbacks,
          container: container!,
          targetSrc: `${basePath}/${config.target}`,
          invariantTargetSrc: config.xr!.invariantTarget ? `${basePath}/${config.xr!.invariantTarget}` : undefined,
          targetRegions: config.targetRegions,
          aspectRatio: config.aspectRatio || 1,
          muralWidth: config.xr!.muralWidth,
          onEnded: () => {
            // Left the AR view (e.g. back button): offer to start again.
            if (currentEngine !== xrEngine) return;
            currentEngine = null;
            userHasTapped = false;
            startMuralSession(activeMuralId);
          },
        });
        try {
          await xrEngine.start();
          engine = xrEngine;
          console.log('[MuralAR] Using ARCore scene tracking');
        } catch (err) {
          console.warn('[MuralAR] ARCore session unavailable, using image tracking:', err);
          xrEngine.stop();
        }
      }

      if (!engine) {
        engine = new AREngine({
          ...callbacks,
          container: container!,
          targetSrc: `${basePath}/${config.target}`,
          onOcclusion: (strength) => {
            currentLayers.forEach((layer) => layer.setOcclusion(strength));
          },
          occludePeople: isOcclusionEnabled(config),
          aspectRatio: config.aspectRatio,
          targetRegions: config.targetRegions,
        });
      }
      currentEngine = engine;
      const activeEngine = engine;

      // Instantiate video layers
      // Pass target aspect ratio so geometry matches the MindAR anchor plane
      const targetAR = config.aspectRatio || 1;
      const depthOptions = {
        depthScale: getDepthScaleOverride(),
        grain: config.wall?.grain ?? DEFAULT_WALL_GRAIN,
      };
      const depth = activeEngine instanceof XREngine ? activeEngine.depth : null;
      const occludeObjects = depth?.available && isOcclusionEnabled(config);
      currentLayers = config.layers.map((layerConfig, index) => {
        const layer = new PackedVideoLayer(layerConfig, basePath, targetAR, index, depthOptions);
        activeEngine.contentGroup.add(layer.mesh);
        if (activeEngine.peopleMask) layer.setOccluder(activeEngine.peopleMask.texture, activeEngine.peopleMask.occluderMap);
        if (depth && occludeObjects) layer.setDepthOccluder(depth.uniforms);
        return layer;
      });

      primeVideosForIOS(currentLayers);

      overlay.show('scanning');
      if (activeEngine instanceof AREngine) await activeEngine.start();

      // Sync layer geometry if detected AR from .mind differs from default
      const detectedAR = activeEngine.detectedAspectRatio;
      if (detectedAR) {
        console.log(`[MuralAR] Target aspect ratio detected: ${detectedAR.toFixed(4)} (config: ${targetAR})`);
        if (!config.aspectRatio) {
          currentLayers.forEach((layer) => layer.updateAspectRatio(detectedAR));
        }
      }
    } catch (err) {
      console.error(`[MuralAR] Failed to start AR for ${muralId}:`, err);
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        overlay.show('camera-denied');
      } else {
        overlay.show('unsupported');
      }
    }
  }

  function switchMural(muralId: string): void {
    activeMuralId = muralId;
    selector.setActiveMural(muralId);
    startMuralSession(muralId);
  }

  // Start initial mural session
  await startMuralSession(activeMuralId);
}

main().catch(console.error);
