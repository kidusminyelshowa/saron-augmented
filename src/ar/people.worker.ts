/**
 * People mask worker
 *
 * Finds people in a camera frame and returns a soft mask of them, so the AR
 * layers can be hidden where someone stands in front of the wall.
 *
 * Two stages keep it accurate for small, full-body figures at a distance
 * (where whole-frame segmentation models miss them) and stop the painted
 * figure in the mural from being mistaken for a real person:
 *   1. An object detector (COCO "person") finds boxes around real people.
 *   2. A person segmenter outlines each person inside their own box.
 *
 * Runs off the main thread so tracking and rendering stay smooth.
 */

import { FilesetResolver, ImageSegmenter, ObjectDetector } from '@mediapipe/tasks-vision';
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

export interface PeopleRequest {
  type: 'init';
  detectorModel: string;
  segmenterModel: string;
}

export interface PeopleFrame {
  type: 'frame';
  frame: ImageBitmap;
  /** Mask size in pixels (same aspect as the frame). */
  maskWidth: number;
  maskHeight: number;
}

export type PeopleResponse =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'mask'; mask: ImageBitmap | null; people: number; ms: number };

/** Minimum detector score to count as a person. */
const SCORE_THRESHOLD = 0.35;
/** Most people outlined per frame (keeps the cost bounded in a crowd). */
const MAX_PEOPLE = 5;
/** Box padding (fraction of box size) so limbs at the box edge are not clipped. */
const BOX_PAD_X = 0.15;
const BOX_PAD_Y = 0.08;
/** Longest side of the crop given to the segmenter. */
const CROP_SIZE = 256;

const ctx = self as unknown as {
  postMessage(message: PeopleResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<PeopleRequest | PeopleFrame>) => void) | null;
};

let detector: ObjectDetector | null = null;
let segmenter: ImageSegmenter | null = null;

async function init(req: PeopleRequest): Promise<void> {
  // The wasm loader is a classic script that defines a global ModuleFactory,
  // which each task consumes (and clears) when it is created. Module workers
  // can't importScripts, so evaluate it in global scope before each task.
  const loader = await (await fetch(wasmLoaderUrl)).text();
  const defineModuleFactory = () => (0, eval)(`${loader}\n;self.ModuleFactory = ModuleFactory;`);

  const fileset = await FilesetResolver.forVisionTasks('');
  fileset.wasmLoaderPath = wasmLoaderUrl;
  fileset.wasmBinaryPath = wasmBinaryUrl;

  defineModuleFactory();
  detector = await ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: req.detectorModel, delegate: 'CPU' },
    runningMode: 'IMAGE',
    categoryAllowlist: ['person'],
    scoreThreshold: SCORE_THRESHOLD,
    maxResults: MAX_PEOPLE,
  });
  defineModuleFactory();
  segmenter = await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: req.segmenterModel, delegate: 'CPU' },
    runningMode: 'IMAGE',
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
}

function process(req: PeopleFrame): void {
  const t0 = performance.now();
  const { frame, maskWidth, maskHeight } = req;
  const W = frame.width;
  const H = frame.height;

  const boxes = detector!.detect(frame).detections.map((d) => d.boundingBox!).filter(Boolean);
  if (boxes.length === 0) {
    frame.close();
    ctx.postMessage({ type: 'mask', mask: null, people: 0, ms: performance.now() - t0 });
    return;
  }

  const mask = new OffscreenCanvas(maskWidth, maskHeight);
  const mctx = mask.getContext('2d')!;
  mctx.fillStyle = '#000';
  mctx.fillRect(0, 0, maskWidth, maskHeight);
  const toMask = maskWidth / W;

  for (const b of boxes) {
    const x = Math.max(0, b.originX - b.width * BOX_PAD_X);
    const y = Math.max(0, b.originY - b.height * BOX_PAD_Y);
    const w = Math.min(W - x, b.width * (1 + 2 * BOX_PAD_X));
    const h = Math.min(H - y, b.height * (1 + 2 * BOX_PAD_Y));
    if (w < 4 || h < 4) continue;

    const s = CROP_SIZE / Math.max(w, h);
    const crop = new OffscreenCanvas(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
    crop.getContext('2d')!.drawImage(frame, x, y, w, h, 0, 0, crop.width, crop.height);

    const result = segmenter!.segment(crop as unknown as ImageData);
    const conf = result.confidenceMasks?.[0];
    if (conf) {
      const values = conf.getAsFloat32Array();
      const tile = new ImageData(conf.width, conf.height);
      for (let i = 0; i < values.length; i++) {
        tile.data[i * 4] = tile.data[i * 4 + 1] = tile.data[i * 4 + 2] = 255;
        tile.data[i * 4 + 3] = values[i] * 255;
      }
      const tileCanvas = new OffscreenCanvas(conf.width, conf.height);
      tileCanvas.getContext('2d')!.putImageData(tile, 0, 0);
      mctx.drawImage(tileCanvas, x * toMask, y * toMask, w * toMask, h * toMask);
    }
    result.close();
  }
  frame.close();

  const bitmap = mask.transferToImageBitmap();
  ctx.postMessage({ type: 'mask', mask: bitmap, people: boxes.length, ms: performance.now() - t0 }, [bitmap]);
}

ctx.onmessage = async (e) => {
  try {
    if (e.data.type === 'init') {
      await init(e.data);
      ctx.postMessage({ type: 'ready' });
    } else if (detector && segmenter) {
      process(e.data);
    } else {
      e.data.frame.close();
    }
  } catch (err) {
    if (e.data.type === 'frame') e.data.frame.close();
    ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
