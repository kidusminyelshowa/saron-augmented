#!/usr/bin/env python3
"""
Build a patch mask: where the animated figures are painted on the wall.

The background layer is shown only inside this mask (LayerConfig.mask), so it
covers the painted figures that would otherwise show through next to their
animated, popped-out copies, while the rest of the real mural stays visible.

The mask is the union of the given layers' alpha mattes over every frame
(they move a little), grown by --grow px for tracking error and feathered by
--feather px. White = show the background layer.

Requires: ffmpeg on PATH, numpy, opencv-python-headless, Pillow.

Example
  python3 tools/make_patch_mask.py --dir public/murals/mural-001 \
      --layers woman_AR.mp4 ensira_AR.mp4 hand_AR.mp4 logs_AR.mp4 \
      --out public/murals/mural-001/patch-mask.png
"""

import argparse
import subprocess

import cv2
import numpy as np
from PIL import Image


def frames(path: str, bands: int):
    probe = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
         '-of', 'csv=p=0', path], capture_output=True, text=True, check=True).stdout.strip().split(',')
    w, h = int(probe[0]), int(probe[1])
    band = h // bands
    proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
                            stdout=subprocess.PIPE)
    while True:
        buf = proc.stdout.read(w * h)
        if len(buf) < w * h:
            break
        yield np.frombuffer(buf, np.uint8).reshape(h, w)[band:2 * band]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dir', required=True)
    ap.add_argument('--layers', nargs='+', required=True)
    ap.add_argument('--bands', type=int, default=3)
    ap.add_argument('--grow', type=int, default=14, help='px to grow the silhouettes by')
    ap.add_argument('--feather', type=int, default=10, help='px of soft edge')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    union = None
    for name in args.layers:
        for alpha in frames(f'{args.dir}/{name}', args.bands):
            m = alpha > 40
            union = m if union is None else union | m
    mask = union.astype(np.uint8)
    # Fill small holes and gaps between shapes, then grow.
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)
    g = 2 * args.grow + 1
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (g, g)))
    soft = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), max(args.feather / 2, 0.1))
    # Keep the grown edge at full strength; fade only outside it.
    soft = np.clip(soft * 2, 0, 1)
    Image.fromarray((soft * 255).astype(np.uint8), 'L').save(args.out, optimize=True)
    print(f'{args.out}: {soft.shape[1]}x{soft.shape[0]}, coverage {soft.mean():.3f}')


if __name__ == '__main__':
    main()
