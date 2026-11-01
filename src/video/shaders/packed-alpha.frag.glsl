// Fragment shader — packed alpha video layer
//
// The source video is vertically packed:
//   Top half    → RGB color (y ∈ [0.5, 1.0])
//   Bottom half → Luma alpha matte (y ∈ [0.0, 0.5])
//
// Solves:
//  1. Video compression ghosting & noise trails in alpha matte (via threshold gate & smoothstep)
//  2. Bilinear texture bleed across the 0.5 split seam (via UV margin clamping)
//  3. Black halos / edge fringing from straight-alpha compression on black canvas (via de-fringing)
//  4. Clean multiply blending for overlay layers (e.g. bubbles)

uniform sampler2D uTexture;
uniform float uOpacity;
uniform float uAlphaThreshold; // Noise gate threshold (e.g. 0.06)
uniform float uDefringe;       // Edge de-fringing strength (0.0 to 1.0)
uniform int uBlendMode;        // 0: Normal, 1: Multiply, 2: Additive
uniform vec2 uParallax;        // Parallax texture offset in UV units

varying vec2 vUv;

void main() {
  // Shift content for parallax, then clamp UVs to avoid bilinear sampling bleed
  // across the 0.5 seam or outer borders. Clamping also stretches edge pixels
  // into the area uncovered by the shift, so no blank strip appears.
  vec2 uv = vUv - uParallax;
  float clampedX = clamp(uv.x, 0.001, 0.999);
  float clampedY = clamp(uv.y, 0.001, 0.999);

  // Remap to top half (RGB) and bottom half (Alpha) with safe half-pixel inset
  vec2 rgbUv = vec2(clampedX, clampedY * 0.498 + 0.501);
  vec2 alphaUv = vec2(clampedX, clampedY * 0.498 + 0.001);

  vec4 rgbSample = texture2D(uTexture, rgbUv);
  vec4 alphaSample = texture2D(uTexture, alphaUv);

  float rawAlpha = alphaSample.r;

  // 1. Noise gate: discard video compression ringing and macroblock trails
  if (rawAlpha < uAlphaThreshold) {
    discard;
  }

  // 2. Smoothly feather the alpha above the noise threshold
  float alpha = smoothstep(uAlphaThreshold, min(uAlphaThreshold + 0.12, 1.0), rawAlpha) * uOpacity;
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

  // 4. Output according to blend mode
  if (uBlendMode == 1) {
    // Multiply blend mode: interpolate toward white (identity) as alpha decreases
    vec3 multiplyColor = mix(vec3(1.0), cleanRgb, alpha);
    gl_FragColor = vec4(multiplyColor, 1.0);
  } else {
    // Normal / Additive blend mode
    gl_FragColor = vec4(cleanRgb, alpha);
  }
}
