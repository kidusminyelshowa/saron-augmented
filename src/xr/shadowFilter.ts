/**
 * Shadow-removing ("illumination-invariant") grayscale filter.
 *
 * From outdoor robotics research on localising in changing sunlight
 * (Maddern et al., ICRA 2014 workshop; McManus et al., "Shady Dealings",
 * ICRA 2014): for daylight, a shadow mostly scales the light's intensity and
 * shifts its colour along a fixed direction, so the combination
 *
 *   I = log G − α·log B − (1 − α)·log R
 *
 * (on linear RGB) stays nearly the same in sun and in shade. The mural's
 * painted shapes keep their contrast while hard shadow edges disappear.
 *
 * The result is contrast-stretched (2nd–98th percentile) so it doesn't depend
 * on exposure or white balance, which only add a constant to I.
 * tools/make_invariant_targets.py applies the same filter to the target images.
 */

export const INVARIANT_ALPHA = 0.4;

const LOG_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  const lin = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  LOG_LIN[i] = Math.log(lin + 1e-3);
}

const HIST_BINS = 512;
const HIST_MIN = -4;
const HIST_MAX = 4;

/**
 * Write the shadow-invariant grayscale of `src` (RGBA) into `dst` (RGBA,
 * same size; gray in RGB, opaque alpha).
 */
export function shadowInvariant(src: Uint8ClampedArray, dst: Uint8ClampedArray, alpha = INVARIANT_ALPHA): void {
  const n = src.length / 4;
  const values = new Float32Array(n);
  const hist = new Uint32Array(HIST_BINS);
  const binScale = HIST_BINS / (HIST_MAX - HIST_MIN);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = LOG_LIN[src[p + 1]] - alpha * LOG_LIN[src[p + 2]] - (1 - alpha) * LOG_LIN[src[p]];
    values[i] = v;
    const b = Math.min(HIST_BINS - 1, Math.max(0, Math.floor((v - HIST_MIN) * binScale)));
    hist[b]++;
  }
  // Percentiles from the histogram.
  const pick = (q: number) => {
    const target = q * n;
    let acc = 0;
    for (let b = 0; b < HIST_BINS; b++) {
      acc += hist[b];
      if (acc >= target) return HIST_MIN + (b + 0.5) / binScale;
    }
    return HIST_MAX;
  };
  const lo = pick(0.02);
  const hi = pick(0.98);
  const scale = 255 / Math.max(hi - lo, 1e-3);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const g = (values[i] - lo) * scale;
    const c = g < 0 ? 0 : g > 255 ? 255 : g;
    dst[p] = dst[p + 1] = dst[p + 2] = c;
    dst[p + 3] = 255;
  }
}
