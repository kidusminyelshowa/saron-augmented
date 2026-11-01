#!/usr/bin/env python3
"""
Repack an AR layer video into the 3-band format used by PackedVideoLayer
(packing: "color-alpha-depth"):

    top third    : RGB color
    middle third : alpha matte (luma)
    bottom third : depth map (luma, white = closest to the viewer)

Sources
  --src video.mp4      An existing 2-band packed video (color over alpha), or a
                       transparent VP9 .webm (real alpha channel). Its frame is
                       placed on the new canvas at --dx/--dy.
  --still image.png    A still RGBA image (e.g. a Photoshop layer export) the
                       size of the canvas, animated with --anim.

Depth
  The depth band is generated from the alpha matte: every shape gets a rounded
  "pillow" profile (0 at its edge, rising to 1 at --radius px inside), so it
  reads as a solid object rather than a flat cut-out. --gradient adds a
  top-to-bottom ramp (useful for a water surface coming towards the viewer).

Requires: ffmpeg on PATH, numpy, opencv-python-headless, Pillow.

Example
  python3 tools/repack_layer.py --src old/woman_AR.mp4 --dy 376 \
      --radius 90 --out public/murals/mural-001/woman_AR.mp4
"""

import argparse
import subprocess

import cv2
import numpy as np
from PIL import Image


def parse_size(s: str) -> tuple[int, int]:
    w, h = s.lower().split("x")
    return int(w), int(h)


def probe(path: str) -> tuple[int, int, float, int]:
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames",
        "-of", "csv=p=0", path,
    ]).decode().strip().split(",")
    w, h = int(out[0]), int(out[1])
    num, den = out[2].split("/")
    return w, h, float(num) / float(den), int(out[3])


def read_frames(path: str, w: int, h: int, rgba: bool = False):
    decoder = ["-c:v", "libvpx-vp9"] if rgba else []  # libvpx keeps WebM alpha
    pix, ch = ("rgba", 4) if rgba else ("rgb24", 3)
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", *decoder, "-i", path, "-f", "rawvideo", "-pix_fmt", pix, "-"],
        stdout=subprocess.PIPE,
    )
    size = w * h * ch
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        yield np.frombuffer(buf, np.uint8).reshape(h, w, ch)
    proc.wait()


def pillow_depth(alpha: np.ndarray, radius: float) -> np.ndarray:
    """Rounded depth profile from an alpha matte (0..1 float in, 0..1 float out)."""
    mask = (alpha > 0.5).astype(np.uint8)
    if radius <= 0:
        return mask.astype(np.float32)
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    t = np.clip(dist / radius, 0.0, 1.0)
    # Circular profile: steep at the edge, flat on top.
    depth = np.sqrt(1.0 - (1.0 - t) ** 2)
    # Soften so the relief has no hard creases.
    return cv2.GaussianBlur(depth, (0, 0), max(radius / 6.0, 1.0))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--src", help="2-band packed source video (color over alpha)")
    src.add_argument("--still", help="Still RGBA image the size of --canvas")
    ap.add_argument("--out", required=True)
    ap.add_argument("--canvas", default="1200x1951", help="Artwork size in source pixels")
    ap.add_argument("--size", default="720x1170", help="Output band size")
    ap.add_argument("--dx", type=int, default=0, help="Source frame x offset on the canvas")
    ap.add_argument("--dy", type=int, default=0, help="Source frame y offset on the canvas")
    ap.add_argument("--radius", type=float, default=60, help="Pillow radius in output px (0 = flat)")
    ap.add_argument("--gradient", type=float, default=0.0,
                    help="Blend in a top-to-bottom depth ramp (0..1) over the shape's rows")
    ap.add_argument("--depth-gain", type=float, default=1.0, help="Scale the final depth (0..1)")
    ap.add_argument("--anim", choices=["none", "warp", "ripple"], default="none",
                    help="Animation applied to a --still source")
    ap.add_argument("--anim-strength", type=float, default=1.0)
    ap.add_argument("--frames", type=int, default=240)
    ap.add_argument("--fps", type=float, default=24)
    ap.add_argument("--crf", type=int, default=20)
    args = ap.parse_args()

    cw, ch = parse_size(args.canvas)
    ow, oh = parse_size(args.size)
    sx, sy = ow / cw, oh / ch

    if args.src:
        sw, sh, fps, nframes = probe(args.src)
        rgba_src = args.src.lower().endswith(".webm")
        band = sh if rgba_src else sh // 2
        frames = read_frames(args.src, sw, sh, rgba_src)
    else:
        still = Image.open(args.still).convert("RGBA").resize((cw, ch), Image.LANCZOS)
        still_np = np.asarray(still).astype(np.float32) / 255.0
        fps, nframes = args.fps, args.frames
        frames = None

    enc = subprocess.Popen([
        "ffmpeg", "-v", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{ow}x{oh * 3}", "-r", str(fps), "-i", "-",
        "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", str(args.crf),
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", args.out,
    ], stdin=subprocess.PIPE)

    # Pre-compute the canvas → output mapping for placing the source frame.
    place = np.float32([[sx, 0, args.dx * sx], [0, sy, args.dy * sy]])
    ys = np.linspace(0.0, 1.0, oh, dtype=np.float32)[:, None]

    count = 0
    for i in range(nframes):
        if frames is not None:
            try:
                frame = next(frames)
            except StopIteration:
                break
            if rgba_src:
                f = frame.astype(np.float32) / 255.0
                alpha_src = np.ascontiguousarray(f[..., 3])
                color_src = np.ascontiguousarray(f[..., :3] * f[..., 3:4])  # on black
            else:
                color_src = frame[:band].astype(np.float32) / 255.0
                alpha_src = frame[band:band * 2, :, 0].astype(np.float32) / 255.0
            color = cv2.warpAffine(color_src, place, (ow, oh), flags=cv2.INTER_AREA, borderValue=0)
            alpha = cv2.warpAffine(alpha_src, place, (ow, oh), flags=cv2.INTER_AREA, borderValue=0)
        else:
            rgba = cv2.resize(still_np, (ow, oh), interpolation=cv2.INTER_AREA)
            t = i / nframes * 2 * np.pi  # one full cycle per loop → seamless
            if args.anim != "none":
                xx, yy = np.meshgrid(np.arange(ow, dtype=np.float32), np.arange(oh, dtype=np.float32))
                s = args.anim_strength
                if args.anim == "warp":
                    # Slow sway of vertical drips: horizontal offset varies with height.
                    mx = xx + s * 3.0 * np.sin(yy / 90.0 + t) + s * 1.5 * np.sin(yy / 37.0 - 2 * t)
                    my = yy + s * 1.5 * np.sin(xx / 120.0 + t)
                else:
                    # Ripple: gentle travelling waves, stronger lower down (closer water).
                    k = 0.4 + yy / oh
                    mx = xx + s * 4.0 * k * np.sin(yy / 23.0 - t)
                    my = yy + s * 2.0 * k * np.sin(xx / 61.0 + yy / 31.0 + t)
                rgba = cv2.remap(rgba, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            color, alpha = rgba[..., :3] * rgba[..., 3:4], rgba[..., 3]

        depth = pillow_depth(alpha, args.radius)
        if args.gradient > 0:
            rows = np.where(alpha.max(axis=1) > 0.5)[0]
            if len(rows):
                ramp = np.clip((ys - rows[0] / oh) / max((rows[-1] - rows[0]) / oh, 1e-3), 0, 1)
                depth = depth * (1 - args.gradient) + ramp * args.gradient * (alpha > 0.5)
        depth = np.clip(depth * args.depth_gain, 0, 1)

        out = np.concatenate([
            color,
            np.repeat(alpha[..., None], 3, axis=2),
            np.repeat(depth[..., None], 3, axis=2),
        ], axis=0)
        enc.stdin.write((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes())
        count += 1

    enc.stdin.close()
    enc.wait()
    print(f"{args.out}: {count} frames, {ow}x{oh * 3} @ {fps:g} fps")


if __name__ == "__main__":
    main()
