#!/usr/bin/env python3
"""
make-icons.py — draws the SireFlex app icons with no image library.

There is no Pillow or ImageMagick in this environment, and an icon is just a
grid of numbers, so the PNG is assembled by hand: rasterise into a float
buffer at 4x, box-filter it down for antialiasing, then wrap the bytes in the
three chunks a PNG needs (IHDR, IDAT, IEND).

The mark is the siren's own sweep split into the lightbar's two colours —
the same shape the faceplate is branded with, so the home-screen icon and
the panel agree. It is stroked by distance field rather than by filling a
path, which gives round caps and joins for free, and the red/blue split
falls out of whichever half of the polyline a pixel is nearer to.

Usage:  python3 tools/make-icons.py
"""

import math
import struct
import zlib
from pathlib import Path

SS = 4  # supersampling factor
OUT = Path(__file__).resolve().parent.parent / "icons"

# ----------------------------------------------------------------- PNG

def write_png(path, pixels, w, h):
    """pixels: flat list of (r,g,b) ints, row-major."""
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type 0 (None) for each scanline
        for x in range(w):
            r, g, b = pixels[y * w + x]
            raw += bytes((r, g, b))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


# ----------------------------------------------------------------- drawing

RED = (226, 32, 42)
BLUE = (47, 92, 240)

# The mark, in its own 72 x 44 space — the same geometry the faceplate uses.
MARK_W, MARK_H = 72.0, 44.0
MARK_RED = [(6, 34), (22, 11), (36, 34)]
MARK_BLUE = [(36, 34), (50, 11), (66, 34)]
MARK_STROKE = 7.0


def seg_dist_one(px, py, ax, ay, bx, by):
    """Distance from a point to a line segment."""
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / denom))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def seg_dist(px, py, pts):
    """Distance to a polyline. Round caps and joins come out of this for free."""
    best = float("inf")
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        d = seg_dist_one(px, py, ax, ay, bx, by)
        if d < best:
            best = d
    return best


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    t = max(0.0, min(1.0, t))
    return tuple(lerp(c1[i], c2[i], t) for i in range(3))


def rounded_rect_sdf(x, y, w, h, r):
    """Signed distance to a rounded rectangle centred in a w x h box."""
    qx = abs(x - w / 2) - (w / 2 - r)
    qy = abs(y - h / 2) - (h / 2 - r)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


def render(size, maskable=False):
    """Returns a flat list of (r,g,b) at the requested size."""
    n = size * SS
    # Inside a maskable icon the OS may crop to a circle, so the artwork is
    # pulled into the middle 80% safe zone and the plate fills the whole tile.
    inset = n * 0.0 if maskable else n * 0.035
    radius = n * 0.5 if maskable else n * 0.225
    # Share of the tile the mark spans. The maskable tile keeps more margin so
    # the artwork survives a circular crop.
    art = 0.56 if maskable else 0.72

    buf = [(0, 0, 0)] * (n * n)
    cx = cy = n / 2

    # Fit the mark into the tile, centred, at `art` of the full width.
    scale = (n * art) / MARK_W
    ox = cx - (MARK_W * scale) / 2
    oy = cy - (MARK_H * scale) / 2
    place = lambda pts: [(ox + x * scale, oy + y * scale) for x, y in pts]
    red_pts = place(MARK_RED)
    blue_pts = place(MARK_BLUE)
    half = (MARK_STROKE * scale) / 2
    AA = 0.75

    # Bounding box of the stroked mark. Testing distance to the polyline for
    # every pixel of a supersampled 512 tile is millions of hypots in pure
    # Python; outside this box the answer is always "no ink", so skip it.
    all_pts = red_pts + blue_pts
    pad = half + AA + 1
    bx0 = min(x for x, _ in all_pts) - pad
    bx1 = max(x for x, _ in all_pts) + pad
    by0 = min(y for _, y in all_pts) - pad
    by1 = max(y for _, y in all_pts) + pad

    for y in range(n):
        for x in range(n):
            d = rounded_rect_sdf(x - inset, y - inset, n - 2 * inset, n - 2 * inset, radius)
            if d > 1.0:
                buf[y * n + x] = (13, 15, 17)
                continue

            v = y / n
            col = mix((44, 49, 52), (18, 21, 23), v)          # brushed charcoal body
            col = mix(col, (60, 66, 70), max(0.0, 1 - v * 3) * 0.5)  # top highlight

            # red on the left, blue on the right — the lightbar, as a wash
            gl = max(0.0, 1 - math.hypot(x - n * 0.14, y - n * 0.30) / (n * 0.62))
            gr = max(0.0, 1 - math.hypot(x - n * 0.86, y - n * 0.30) / (n * 0.62))
            col = mix(col, (226, 32, 38), gl ** 2 * 0.62)
            col = mix(col, (32, 78, 235), gr ** 2 * 0.62)

            # ---- the SireFlex mark -----------------------------------
            ink = 0.0
            col_ink = None
            if bx0 <= x <= bx1 and by0 <= y <= by1:
                # Named dm, not d: `d` already holds the distance to the
                # plate's own edge, and the plate's antialiasing below reads
                # it. Shadowing it here painted the mark's bounding box black.
                d_red = seg_dist(x, y, red_pts)
                d_blue = seg_dist(x, y, blue_pts)
                dm = min(d_red, d_blue)
                if dm <= half + AA:
                    # Antialias the stroke edge over one supersampled pixel.
                    ink = 1.0 if dm <= half - AA else (half + AA - dm) / (2 * AA)
                    # Whichever half of the sweep is nearer owns the pixel, so
                    # the colour split needs no clipping of its own.
                    col_ink = RED if d_red <= d_blue else BLUE

            if ink > 0:
                col = mix(col, col_ink, ink)

            # antialias the plate edge
            if d > -1.0:
                col = mix((13, 15, 17), col, (1.0 - d) / 2.0)

            buf[y * n + x] = tuple(int(max(0, min(255, c))) for c in col)

    # box-filter down to the target size
    out = [(0, 0, 0)] * (size * size)
    inv = 1.0 / (SS * SS)
    for y in range(size):
        for x in range(size):
            r = g = b = 0
            for dy in range(SS):
                row = (y * SS + dy) * n + x * SS
                for dx in range(SS):
                    p = buf[row + dx]
                    r += p[0]; g += p[1]; b += p[2]
            out[y * size + x] = (int(r * inv), int(g * inv), int(b * inv))
    return out


def main():
    OUT.mkdir(exist_ok=True)
    jobs = [
        ("apple-touch-icon.png", 180, False),
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
    ]
    for name, size, maskable in jobs:
        write_png(OUT / name, render(size, maskable), size, size)
        print(f"  {name:26} {size}x{size}  {(OUT / name).stat().st_size:>7,} bytes")


if __name__ == "__main__":
    main()
