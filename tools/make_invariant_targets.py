#!/usr/bin/env python3
"""
Make shadow-invariant versions of a mural's tracking images, for compiling the
second .mind file used by the Android (WebXR) mode.

Applies the same filter as src/xr/shadowFilter.ts (log-chromaticity
illumination invariant, then a 2nd-98th percentile stretch) to the wall photo
and to each close-up region, writing inv0.jpg, inv1.jpg, ... in the same order
as targetRegions in the mural's config.json. Compile them with MindAR's
compiler, in that order, into <name>-invariant.mind.

Example
  python3 tools/make_invariant_targets.py \
      --photo tools/targets/mural-001/wall-photo.jpg \
      --config public/murals/mural-001/config.json --out build/invariant
"""

import argparse
import json
import os

import numpy as np
from PIL import Image

ALPHA = 0.4


def log_lin(c: np.ndarray) -> np.ndarray:
    c = c / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return np.log(lin + 1e-3)


def invariant(img: Image.Image) -> Image.Image:
    f = np.asarray(img.convert("RGB")).astype(np.float32)
    v = log_lin(f[..., 1]) - ALPHA * log_lin(f[..., 2]) - (1 - ALPHA) * log_lin(f[..., 0])
    lo, hi = np.percentile(v, 2), np.percentile(v, 98)
    g = np.clip((v - lo) * 255.0 / max(hi - lo, 1e-3), 0, 255)
    return Image.fromarray(g.astype(np.uint8)).convert("RGB")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--photo", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    photo = Image.open(args.photo).convert("RGB")
    W, H = photo.size
    regions = json.load(open(args.config)).get("targetRegions") or [[0, 0, 1, 1]]
    for i, (x, y, w, h) in enumerate(regions):
        crop = photo.crop((round(x * W), round(y * H), round((x + w) * W), round((y + h) * H)))
        path = os.path.join(args.out, f"inv{i}.jpg")
        invariant(crop).save(path, quality=95)
        print(path, crop.size)


if __name__ == "__main__":
    main()
