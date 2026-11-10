// Fragment shader — water spilling from the mural onto the ground.
//
// Draws on a ground plane that starts at the foot of the wall. The colour
// comes from the water layer's packed video (colour band), reading the
// bottom of the painted water and continuing it toward the viewer, so the
// spill keeps the artist's colours and the animated ripples. A ragged,
// slowly moving outline grows out from the wall as uReveal goes 0 → 1.

uniform sampler2D uTexture;
uniform float uBands;          // Bands in the packed video (2 or 3)
uniform float uOpacity;
uniform vec3 uLight;           // Per-channel light multiplier matched to the camera
uniform vec2 uSize;            // Plane width and depth (mural widths)
uniform float uSpread;         // How far the spill fans out past each side of the mural (mural widths)
uniform float uSourceTop;      // Highest row of the water layer to read (0 = top of mural, 1 = bottom)
uniform float uReveal;         // 0 = still inside the mural, 1 = fully spilled
uniform float uTime;           // Seconds, for the moving edge and surface wobble

varying vec2 vUv;

const float BAND_INSET = 0.004;

float bandV(float y, float band) {
  float inset = clamp(y, 0.0, 1.0) * (1.0 - 2.0 * BAND_INSET) + BAND_INSET;
  return (inset + (uBands - 1.0 - band)) / uBands;
}

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

// Mirror a coordinate into 0..1 so the water continues past the mural's sides without streaks.
float mirror01(float x) {
  float m = mod(x, 2.0);
  return m > 1.0 ? 2.0 - m : m;
}

void main() {
  if (uReveal <= 0.0) discard;

  float x = (vUv.x - 0.5) * uSize.x;   // across the wall, 0 = mural centre
  float d = (1.0 - vUv.y) * uSize.y;   // distance out from the wall
  float t = d / uSize.y;

  // Outline: fans out past the mural's sides and reaches out with a ragged, drifting front.
  float edgeNoise = valueNoise(vec2(x * 5.0, uTime * 0.12)) * 0.65
                  + valueNoise(vec2(x * 14.0 + 7.0, uTime * 0.25)) * 0.35;
  // At the wall the spill is exactly as wide as the mural, with square corners;
  // it only fans out (and gets a ragged side edge) further from the wall.
  float fan = smoothstep(0.0, 0.6, t);
  float halfW = 0.5 + uSpread * uReveal * fan
              + 0.03 * fan * (valueNoise(vec2(d * 9.0, uTime * 0.2 + 3.0)) - 0.5);
  float side = 1.0 - smoothstep(0.5, 0.5 + uSpread + 0.001, abs(x)); // shorter reach out at the sides
  float reach = uSize.y * uReveal * (0.5 + 0.5 * edgeNoise) * (0.55 + 0.45 * side);

  float frontMask = 1.0 - smoothstep(reach - 0.035, reach, d);
  float soft = mix(0.002, 0.03, fan);
  float sideMask = 1.0 - smoothstep(halfW - soft, halfW, abs(x));
  float mask = frontMask * sideMask;
  if (mask < 0.003) discard;

  // Surface: the bottom of the painted water carried out over the ground, with a gentle wobble.
  float wobble = 0.004 * sin(d * 38.0 - uTime * 1.6) + 0.003 * sin(x * 23.0 + uTime * 1.1);
  float sy = 1.0 - (mix(1.0, uSourceTop, t) + wobble); // texture V runs bottom-up
  float sx = mirror01(x + 0.5 + 0.5 * wobble);
  vec3 col = texture2D(uTexture, vec2(sx, bandV(sy, 0.0))).rgb;
  float a = texture2D(uTexture, vec2(sx, bandV(sy, 1.0))).r;
  col /= max(a, 0.2); // stored on black

  // Drawn-looking ripple lines, like the painted ones, drifting out from the wall.
  float rn = valueNoise(vec2(x * 4.0, d * 14.0 - uTime * 0.6)) * 0.7 + valueNoise(vec2(x * 11.0, d * 30.0)) * 0.3;
  float ripple = 1.0 - smoothstep(0.012, 0.03, abs(rn - 0.5));
  col = mix(col, vec3(0.62, 0.86, 0.9), ripple * 0.7 * smoothstep(0.02, 0.1, d));

  // Thin film near the advancing edge: lighter, more see-through, with a foam line.
  float film = smoothstep(0.0, 0.12, reach - d);
  float foam = smoothstep(reach - 0.05, reach - 0.02, d) * (1.0 - smoothstep(reach - 0.02, reach, d));
  col = mix(col, vec3(0.85, 0.95, 0.95), foam * 0.35);

  float alpha = mask * mix(0.55, 1.0, film) * clamp(a * 1.2, 0.0, 1.0) * uOpacity;
  gl_FragColor = vec4(col * uLight, alpha);
}
