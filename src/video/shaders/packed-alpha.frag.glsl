// Fragment shader — packed alpha video layer
//
// The source video is vertically packed:
//   Top half  → RGB color
//   Bottom half → Luma (grayscale) alpha matte
//
// This shader reconstructs RGBA from the packed format.

uniform sampler2D uTexture;
uniform float uOpacity;
uniform float uAlphaThreshold;

varying vec2 vUv;

void main() {
  // Sample the RGB color from the top half of the texture
  vec2 rgbUv = vec2(vUv.x, vUv.y * 0.5 + 0.5);
  vec4 rgbSample = texture2D(uTexture, rgbUv);

  // Sample the alpha matte from the bottom half of the texture
  vec2 alphaUv = vec2(vUv.x, vUv.y * 0.5);
  vec4 alphaSample = texture2D(uTexture, alphaUv);

  // Use the red channel of the luma matte as alpha
  float alpha = alphaSample.r * uOpacity;

  // Discard fragments below the alpha threshold to avoid halo artifacts
  if (alpha < uAlphaThreshold) {
    discard;
  }

  gl_FragColor = vec4(rgbSample.rgb, alpha);
}
