#!/usr/bin/env python3
"""
Build the animated background and water layers of mural-001 for the tall
(6.15 m x 10 m, 1200 x 1951 px) layout, from the layered Photoshop file and
the animator's 1200 x 1116 transparent layer animations (VP9 WebM with alpha).

For each layer it writes an intermediate 2-band (color over alpha) video at
canvas size, which tools/repack_layer.py then turns into the 3-band
color/alpha/depth video used by the app.

  background: Layer 1 (static top drips, from the PSD) under bg.webm. The
              PSD's Color Fill 1 (a flat dark red over the whole canvas) is
              left out by default: it made the AR read as a framed box on the
              wall. The flat dark-red back painted into bg.webm itself is
              cut out too (cut_flat_back): large, thick areas of the dark red
              go transparent, while the dark red on the objects (line work,
              the jug, small enclosed shapes) stays.
              Pass --with-fill for the old boxed look.
  water:      Color Fill 2 (static water body, from the PSD) under water.webm,
              with the PSD's Layer 2 ripple lines on top, given a gentle loop.

The PSD layers are expected as canvas-size PNG exports named
canvas_<layer name>.png (e.g. "canvas_Color Fill 1.png").

Example
  python3 tools/compose_mural001.py --psd-dir psd --anim-dir anim --out-dir build
"""

import argparse
import os
import subprocess

import cv2
import numpy as np
from PIL import Image

W, H = 1200, 1951
ANIM_W, ANIM_H = 1200, 1116
FRAMES = 240
FPS = 24

# Canvas row of each animation's first row, from the PSD placement of the
# matching layers (verified against the artwork).
BG_Y = 347
WATER_Y = 400


def load(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGBA")).astype(np.float32) / 255.0


def read_rgba(path: str):
    """Decode a VP9 WebM with alpha into float RGBA frames."""
    proc = subprocess.Popen([
        "ffmpeg", "-v", "error", "-c:v", "libvpx-vp9", "-i", path,
        "-f", "rawvideo", "-pix_fmt", "rgba", "-",
    ], stdout=subprocess.PIPE)
    size = ANIM_W * ANIM_H * 4
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        yield np.frombuffer(buf, np.uint8).reshape(ANIM_H, ANIM_W, 4).astype(np.float32) / 255.0
    proc.wait()


def place(img: np.ndarray, y: int) -> np.ndarray:
    """Place a 1200-wide image on the canvas at row y (cropping to the canvas)."""
    out = np.zeros((H,) + img.shape[1:], np.float32)
    y0, y1 = max(y, 0), min(y + img.shape[0], H)
    out[y0:y1] = img[y0 - y:y1 - y]
    return out


def over(dst_rgb, dst_a, src_rgb, src_a):
    """Straight-alpha 'over' compositing."""
    out_a = src_a + dst_a * (1 - src_a)
    out_rgb = (src_rgb * src_a[..., None] + dst_rgb * (dst_a * (1 - src_a))[..., None]) \
        / np.maximum(out_a, 1e-6)[..., None]
    return out_rgb, out_a


def writer(path: str):
    return subprocess.Popen([
        "ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H * 2}",
        "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "8",
        "-pix_fmt", "yuv444p", path,
    ], stdin=subprocess.PIPE)


def emit(proc, rgb, a):
    rgb = rgb * a[..., None]  # on black, like the other packed layers
    frame = np.concatenate([rgb, np.repeat(a[..., None], 3, axis=2)], axis=0)
    proc.stdin.write((np.clip(frame, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes())


# The background's two paint colours (straight RGB, 0..1).
BG_DARK = np.array([144, 33, 33], np.float32) / 255
BG_ORANGE = np.array([212, 61, 37], np.float32) / 255


def cut_flat_back(rgb: np.ndarray, a: np.ndarray, open_r: int = 6, min_area: int = 4000):
    """Make the flat dark-red back transparent, keeping dark red on the objects.

    The back is told apart from the objects by shape, not colour (both use the
    same red): it is the dark red that survives a morphological opening of
    radius open_r (so it is thicker than any line work) in connected areas of
    at least min_area px. Small thick areas, like the jug, stay. Anti-aliased
    edges against the orange fade out by how red they are, so no dark rim is
    left on the orange shapes.
    """
    dist = np.linalg.norm(rgb - BG_DARK, axis=2)
    dark = ((dist < 0.08) & (a > 0.5)).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * open_r + 1,) * 2)
    thick = cv2.morphologyEx(dark, cv2.MORPH_OPEN, k)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(thick, connectivity=8)
    keep = np.where(stats[1:, cv2.CC_STAT_AREA] >= min_area)[0] + 1
    back = np.isin(lab, keep).astype(np.uint8)
    back = (cv2.dilate(back, k) & dark) | back  # regrow what the opening trimmed
    rim = (cv2.dilate(back, np.ones((5, 5), np.uint8)) > 0) & (back == 0)
    axis = BG_ORANGE - BG_DARK
    t = np.clip(((rgb - BG_DARK) @ axis) / float(axis @ axis), 0, 1)
    reddish = rim & (dist < 0.25)
    a = a.copy()
    rgb = rgb.copy()
    a[back > 0] = 0
    a[reddish] *= t[reddish]
    rgb[reddish] = BG_ORANGE
    return rgb, a


def build_background(psd_dir: str, anim: str, out: str, with_fill: bool = False) -> None:
    top = load(os.path.join(psd_dir, "canvas_Layer 1.png"))
    base_rgb, base_a = top[..., :3], top[..., 3]
    if with_fill:
        fill = load(os.path.join(psd_dir, "canvas_Color Fill 1.png"))
        base_rgb, base_a = over(fill[..., :3], fill[..., 3], base_rgb, base_a)
    proc = writer(out)
    for i, f in enumerate(read_rgba(anim)):
        if i >= FRAMES:
            break
        f = place(f, BG_Y)
        rgb, a = over(base_rgb, base_a, f[..., :3], f[..., 3])
        if not with_fill:
            rgb, a = cut_flat_back(rgb, a)
        emit(proc, rgb, a)
    proc.stdin.close()
    proc.wait()


def build_water(psd_dir: str, anim: str, out: str) -> None:
    body = load(os.path.join(psd_dir, "canvas_Color Fill 2.png"))
    ripples = load(os.path.join(psd_dir, "canvas_Layer 2.png"))
    xx, yy = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    proc = writer(out)
    for i, f in enumerate(read_rgba(anim)):
        if i >= FRAMES:
            break
        t = np.float32(i / FRAMES * 2 * np.pi)  # one cycle per loop → seamless
        f = place(f, WATER_Y)
        rgb, a = over(body[..., :3], body[..., 3], f[..., :3], f[..., 3])
        # Ripple lines drift and undulate gently, more so nearer the viewer.
        k = 0.5 + (yy - 1450) / 600
        mx = xx + 6.0 * k * np.sin(yy / 25.0 - t) + 4.0 * np.sin(t)
        my = yy + 2.0 * k * np.sin(xx / 70.0 + t)
        r = cv2.remap(ripples, mx.astype(np.float32), my.astype(np.float32), cv2.INTER_LINEAR, borderValue=0)
        emit(proc, *over(rgb, a, r[..., :3], r[..., 3]))
    proc.stdin.close()
    proc.wait()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--psd-dir", required=True)
    ap.add_argument("--anim-dir", required=True, help="Folder with bg.webm and water.webm")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--with-fill", action="store_true",
                    help="Keep the flat dark-red Color Fill 1 behind the background")
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    build_background(args.psd_dir, os.path.join(args.anim_dir, "bg.webm"),
                     os.path.join(args.out_dir, "background_canvas.mp4"), args.with_fill)
    build_water(args.psd_dir, os.path.join(args.anim_dir, "water.webm"),
                os.path.join(args.out_dir, "water_canvas.mp4"))


if __name__ == "__main__":
    main()
