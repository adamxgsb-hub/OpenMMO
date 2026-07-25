#!/usr/bin/env python3
"""Turn a photoreal concept render into an OpenMMO inventory icon.

    python make-icon.py trout_render.png raw_trout.png

Does what Jake does by hand: knocks out the flat studio background, trims to
the subject, rotates very long subjects onto the diagonal (his sword icons sit
diagonally so they fill the square), and fits the result into a transparent
128x128 PNG.

Background removal is a flood fill from the image border rather than a colour
key, so grey *inside* the subject survives — important for silver fish on a
grey backdrop. The contact shadow is removed with the background, which is
what you want for an icon.

Requires: pip install pillow numpy
"""
import argparse
import sys
from pathlib import Path
from collections import deque

try:
    from PIL import Image
    import numpy as np
except ImportError:
    sys.exit("pip install pillow numpy")

SIZE = 128
PADDING = 4          # px of breathing room inside the square
ROTATE_ABOVE = 1.7   # width/height ratio past which we go diagonal


def flood_background(rgb, tol):
    """Mask of pixels reachable from the border within `tol` of their seed."""
    h, w, _ = rgb.shape
    arr = rgb.astype(np.int16)
    bg = np.zeros((h, w), dtype=bool)
    seen = np.zeros((h, w), dtype=bool)
    q = deque()

    for x in range(w):
        for y in (0, h - 1):
            if not seen[y, x]:
                seen[y, x] = True
                q.append((y, x, arr[y, x]))
    for y in range(h):
        for x in (0, w - 1):
            if not seen[y, x]:
                seen[y, x] = True
                q.append((y, x, arr[y, x]))

    # Compare each pixel against the neighbour it came from, not the original
    # border pixel, so a smoothly graded backdrop is followed all the way in.
    while q:
        y, x, seed = q.popleft()
        if np.abs(arr[y, x] - seed).max() > tol:
            continue
        bg[y, x] = True
        here = arr[y, x]
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx, here))
    return bg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="a render, or a folder of renders")
    ap.add_argument("dst", help="output icon, or output folder when src is a folder")
    ap.add_argument("--tol", type=int, default=12,
                    help="per-step tolerance; raise if a halo remains, lower if it eats the subject")
    ap.add_argument("--no-rotate", action="store_true",
                    help="keep the subject horizontal even if very wide")
    args = ap.parse_args()

    src = Path(args.src)
    if src.is_dir():
        out = Path(args.dst)
        out.mkdir(parents=True, exist_ok=True)
        renders = sorted(
            f for f in src.iterdir()
            if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
        )
        if not renders:
            sys.exit(f"no images found in {src}")
        for f in renders:
            try:
                convert(f, out / (f.stem + ".png"), args.tol, args.no_rotate)
            except SystemExit as e:
                print(f"  {f.name}: {e}")
        return
    convert(src, Path(args.dst), args.tol, args.no_rotate)


def convert(src, dst, tol, no_rotate):
    im = Image.open(src).convert("RGB")
    # Work at a manageable size; the flood fill is the slow part.
    if max(im.size) > 900:
        im.thumbnail((900, 900), Image.LANCZOS)

    bg = flood_background(np.array(im), tol)
    rgba = im.convert("RGBA")
    a = np.array(rgba)
    a[..., 3] = np.where(bg, 0, 255)
    cut = Image.fromarray(a)

    box = cut.getbbox()
    if not box:
        sys.exit("everything was treated as background - lower --tol")
    cut = cut.crop(box)

    w, h = cut.size
    if not no_rotate and w / h > ROTATE_ABOVE:
        # Long subjects go diagonal so they fill the square, like his swords.
        cut = cut.rotate(-30, resample=Image.BICUBIC, expand=True)
        cut = cut.crop(cut.getbbox())

    inner = SIZE - PADDING * 2
    cut.thumbnail((inner, inner), Image.LANCZOS)

    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(cut, ((SIZE - cut.width) // 2, (SIZE - cut.height) // 2), cut)
    icon.save(dst)
    print(f"wrote {dst} ({SIZE}x{SIZE}, subject {cut.width}x{cut.height})")


if __name__ == "__main__":
    main()
