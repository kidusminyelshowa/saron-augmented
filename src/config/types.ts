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
}

/** Configuration for an entire mural AR experience. */
export interface MuralConfig {
  /** Unique mural identifier. */
  id: string;

  /** Human-readable mural name. */
  name: string;

  /** Path to the MindAR .mind target file. */
  target: string;

  /** Ordered list of video layers to composite over the mural. */
  layers: LayerConfig[];
}
