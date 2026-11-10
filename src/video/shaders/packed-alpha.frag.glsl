// Fragment shader — packed alpha video layer
//
// The source video is vertically packed into equal-height bands:
//   2 bands (default): top = RGB color, bottom = luma alpha matte
//   3 bands:           top = RGB color, middle = luma alpha, bottom = luma depth
//                      (depth: white = closest to the viewer)
//
// Solves:
//  1. Video compression ghosting & noise trails in alpha matte (via threshold gate & smoothstep)
//  2. Bilinear texture bleed across band seams (via UV margin clamping)
//  3. Black halos / edge fringing from straight-alpha compression on black canvas (via de-fringing)
//  4. Clean multiply blending for overlay layers (e.g. bubbles)
//  5. Depth: whole-layer parallax plus per-pixel relief from a depth map
//  6. Wall look: matching the camera's lighting and adding painted-wall grain

uniform sampler2D uTexture;
uniform float uOpacity;
uniform float uAlphaThreshold; // Noise gate threshold (e.g. 0.06)
uniform float uDefringe;       // Edge de-fringing strength (0.0 to 1.0)
uniform int uBlendMode;        // 0: Normal, 1: Multiply, 2: Additive

// Packing & depth
uniform float uBands;          // 2.0 = color+alpha, 3.0 = color+alpha+depth
uniform int uDepthSource;      // 0: none, 1: packed depth band, 2: uDepthMap image
uniform sampler2D uDepthMap;
uniform vec2 uViewTan;         // UV shift per unit of depth (from view angle)
uniform float uLayerDepth;     // Whole-layer distance from the wall (mural widths)
uniform float uRelief;         // Extra distance for white areas of the depth map (mural widths)

// Wall look
uniform vec3 uLight;           // Per-channel light multiplier matched to the camera
uniform float uGrain;          // Painted-wall grain strength (0 = off)
uniform vec2 uWallOrigin;      // Layer centre in wall space (mural widths)
uniform vec2 uWallSize;        // Layer size in wall space (mural widths)
uniform float uGrainScale;     // Grain cells per mural width

// Shadow pass for popped-out layers: draw a soft dark silhouette instead of the colour.
uniform float uShadow;         // 0 = normal layer, > 0 = shadow opacity
uniform float uShadowBlur;     // Blur radius in UV units

// Hide the layer below this row (0 = top, 1 = bottom), e.g. where it dips under the water.
uniform float uCropBottom;

// Repeat this row (0 = top, 1 = bottom) downward to continue a cut-off layer.
uniform float uExtendBelow;

varying vec2 vUv;

const float BAND_INSET = 0.004;

// How far below its edge row a layer is continued (fraction of frame height).
const float EXTEND_LENGTH = 0.08;

// Map a 0..1 coordinate inside a band (0 = top band) to texture V.
float bandV(float y, float band) {
  float inset = clamp(y, 0.0, 1.0) * (1.0 - 2.0 * BAND_INSET) + BAND_INSET;
  return (inset + (uBands - 1.0 - band)) / uBands;
}

float sampleDepth(vec2 uv) {
  vec2 c = clamp(uv, 0.001, 0.999);
  if (uDepthSource == 1) {
    return texture2D(uTexture, vec2(c.x, bandV(c.y, 2.0))).r;
  }
  return texture2D(uDepthMap, c).r;
}

// Cheap hash-based value noise for the wall grain.
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float wallGrain(vec2 wallPos) {
  vec2 p = wallPos * uGrainScale;
  // Broad paint mottling + finer plaster texture, centred on 0.
  float n = valueNoise(p) * 0.5 + valueNoise(p * 2.7) * 0.3 + valueNoise(p * 7.3) * 0.2;
  return n - 0.5;
}

void main() {
  // Parallax: content at distance d from the wall appears shifted by d * view tangent.
  // With a depth map, iterate a few times so each pixel uses its own depth.
  vec2 uv = vUv + uViewTan * uLayerDepth;
  if (uDepthSource != 0 && uRelief > 0.0) {
    for (int i = 0; i < 4; i++) {
      float h = sampleDepth(uv);
      uv = vUv + uViewTan * (uLayerDepth + uRelief * h);
    }
  }

  // Continue a cut-off layer below its edge row (texture V runs bottom-up), for a
  // short stretch only, so it stays hidden behind the water and never shows below it.
  if (1.0 - uv.y > uExtendBelow + EXTEND_LENGTH) discard;
  uv.y = max(uv.y, 1.0 - uExtendBelow);

  float crop = 1.0 - smoothstep(uCropBottom - 0.006, uCropBottom, 1.0 - vUv.y);
  if (crop <= 0.0) discard;

  // Shadow of a popped-out layer: soft silhouette from the alpha band.
  if (uShadow > 0.0) {
    float a = 0.0;
    for (int i = 0; i < 9; i++) {
      vec2 o = vec2(float(i - (i / 3) * 3) - 1.0, float(i / 3) - 1.0) * uShadowBlur;
      vec2 s = clamp(vUv + o, 0.001, 0.999);
      a += smoothstep(uAlphaThreshold, uAlphaThreshold + 0.12, texture2D(uTexture, vec2(s.x, bandV(s.y, 1.0))).r);
    }
    a = a / 9.0 * uShadow * uOpacity * crop;
    if (a < 0.003) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
    return;
  }

  // Clamp UVs to avoid bilinear bleed across band seams or outer borders. Clamping
  // also stretches edge pixels into any area uncovered by the shift, so no blank strip.
  float clampedX = clamp(uv.x, 0.001, 0.999);
  float clampedY = clamp(uv.y, 0.001, 0.999);

  vec4 rgbSample = texture2D(uTexture, vec2(clampedX, bandV(clampedY, 0.0)));
  vec4 alphaSample = texture2D(uTexture, vec2(clampedX, bandV(clampedY, 1.0)));

  float rawAlpha = alphaSample.r;

  // 1. Noise gate: discard video compression ringing and macroblock trails
  if (rawAlpha < uAlphaThreshold) {
    discard;
  }

  // 2. Smoothly feather the alpha above the noise threshold
  float alpha = smoothstep(uAlphaThreshold, min(uAlphaThreshold + 0.12, 1.0), rawAlpha) * uOpacity * crop;
  if (alpha <= 0.001) {
    discard;
  }

  // 3. De-fringe: undo black background contamination at semi-transparent edge pixels
  vec3 cleanRgb = rgbSample.rgb;
  if (uDefringe > 0.0 && rawAlpha > 0.001 && rawAlpha < 0.99) {
    // Un-premultiply color that was darkened against black in the video encoder
    vec3 unmultiplied = clamp(rgbSample.rgb / max(rawAlpha, 0.2), 0.0, 1.0);
    cleanRgb = mix(rgbSample.rgb, unmultiplied, uDefringe);
  }

  // 4. Wall look: grain is fixed to the wall (not the shifted content), then the
  //    camera's light level and colour cast are applied so the layer sits in the scene.
  if (uGrain > 0.0) {
    vec2 wallPos = uWallOrigin + (vUv - 0.5) * uWallSize;
    cleanRgb *= 1.0 + wallGrain(wallPos) * uGrain;
  }
  cleanRgb = clamp(cleanRgb * uLight, 0.0, 1.0);

  // 5. Output according to blend mode
  if (uBlendMode == 1) {
    // Multiply blend mode: interpolate toward white (identity) as alpha decreases
    vec3 multiplyColor = mix(vec3(1.0), cleanRgb, alpha);
    gl_FragColor = vec4(multiplyColor, 1.0);
  } else {
    // Normal / Additive blend mode
    gl_FragColor = vec4(cleanRgb, alpha);
  }
}
