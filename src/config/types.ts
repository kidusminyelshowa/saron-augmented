/**
 * Configuration types for mural definitions.
 * Matches the data model specified in PRD §12.
 */

/** Configuration for a single video layer overlay. */
export interface LayerConfig {
  /** Unique layer identifier. */
  id: string;

  /** Path to the packed MP4 video (RGB + luma alpha). */
  src: string;

  /**
   * Position within the normalized 1:1 mural coordinate system.
   * [x, y] where (0,0) is top-left and (1,1) is bottom-right.
   */
  position: [number, number];

  /**
   * Scale relative to the mural.
   * [scaleX, scaleY] where 1 = full mural width/height.
   */
  scale: [number, number];

  /** Rotation in degrees. */
  rotation: number;

  /** Layer opacity (0–1). */
  opacity: number;

  /** Whether the video should loop. */
  loop: boolean;

  /** Optional blending mode for compositing ('normal' | 'multiply' | 'additive'). */
  blendMode?: 'normal' | 'multiply' | 'additive';

  /**
   * Alpha noise threshold (0–1). Default: 0.06.
   * Discards video compression macroblock noise and ghosting trails.
   */
  alphaThreshold?: number;

  /**
   * Edge de-fringing intensity (0–1). Default: 1.0.
   * Eliminates black halos caused by straight-alpha compression on black canvas.
   */
  defringe?: number;
}

/** Configuration for an entire mural AR experience. */
export interface MuralConfig {
  /** Unique mural identifier. */
  id: string;

  /** Human-readable mural name. */
  name: string;

  /** Path to the MindAR .mind target file. */
  target: string;

  /**
   * Target image aspect ratio (width / height).
   *
   * MindAR normalizes the anchor plane to: width = 1, height = 1/aspectRatio.
   * When present, the engine automatically sizes video layers to match
   * the target geometry so content sticks to the physical artwork.
   */
  aspectRatio?: number;

  /** Ordered list of video layers to composite over the mural. */
  layers: LayerConfig[];
}
