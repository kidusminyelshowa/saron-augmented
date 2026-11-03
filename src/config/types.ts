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

  /**
   * Distance the layer floats in front of the wall, in mural widths. Default: 0.
   * E.g. on a 3 m wide mural, 0.02 = 6 cm. Larger values give stronger parallax.
   * The layer stays aligned with the artwork when viewed head-on and slides
   * within its frame as the viewer moves to the side.
   */
  depth?: number;

  /**
   * How the video is packed into vertical bands. Default: 'color-alpha'.
   * - 'color-alpha':       top half color, bottom half alpha matte.
   * - 'color-alpha-depth': top third color, middle third alpha matte,
   *                        bottom third depth map (white = closest).
   */
  packing?: 'color-alpha' | 'color-alpha-depth';

  /**
   * Optional static grayscale depth map image (white = closest), used when the
   * video has no depth band. Must have the same framing as the layer.
   */
  depthMap?: string;

  /**
   * Extra distance from the wall for the whitest parts of the depth map,
   * in mural widths. Default: 0.03 when a depth map is present.
   */
  relief?: number;

  /**
   * Pop the layer out of the wall as a real 3D plane this far in front of it
   * (mural widths; 0.1 ≈ 0.6 m on a 6 m wall). Unlike `depth`, which shifts
   * the picture within the wall's outline, a popped-out layer moves in front
   * of the wall, can reach past its edges at an angle, and casts a shadow on
   * the wall. Use it for cut-out elements (transparent around them), not
   * full-canvas layers. `depth` is ignored when this is set.
   */
  popOut?: number;

  /** Opacity of a popped-out layer's shadow on the wall (0–1). Default: 0.35. */
  popShadow?: number;

  /**
   * Gentle float towards and away from the wall for a popped-out layer
   * (amplitude in mural widths). Default: 0.
   */
  popFloat?: number;
}

/** How layers blend into the physical wall. */
export interface WallConfig {
  /**
   * Strength of matching the camera's light level and colour cast (0–1). Default: 0.8.
   * 0 shows the videos exactly as authored.
   */
  lightMatch?: number;

  /**
   * Average colour of the artwork (0–1 sRGB) as it would look under neutral light,
   * or a single luminance value when only a grayscale reference is known.
   * Light matching compares what the camera sees on the mural against this.
   * If omitted, light matching only follows changes after the mural is first found.
   */
  reference?: [number, number, number] | number;

  /** Painted-wall grain strength (0–1). Default: 0.12. */
  grain?: number;

  /**
   * Hide the animation where people stand in front of the wall. Default: true.
   * Can be turned off for a visit with ?occlusion=0.
   */
  occludePeople?: boolean;
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

  /**
   * Region of the mural shown by each image compiled into the .mind file, as
   * normalised [x, y, width, height] (0..1, top-left origin), in compile order.
   * Omit for a single whole-mural target. Extra close-up regions let phones
   * without a wide camera lock on from nearer the wall.
   */
  targetRegions?: [number, number, number, number][];

  /** How layers blend into the physical wall (lighting and texture). */
  wall?: WallConfig;

  /** Ordered list of video layers to composite over the mural. */
  layers: LayerConfig[];
}
