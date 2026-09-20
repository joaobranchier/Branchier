#!/usr/bin/env python3
"""
make-icons.py — draws the app icons with no image library.

There is no Pillow or ImageMagick in this environment, and an icon is just a
grid of numbers, so the PNG is assembled by hand: rasterise into a float
buffer at 4x, box-filter it down for antialiasing, then wrap the bytes in the
three chunks a PNG needs (IHDR, IDAT, IEND).

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
    # Smaller divisor = smaller glyph. The maskable tile shrinks further so the
    # artwork survives a circular crop.
    art = 0.62 if maskable else 0.82

    buf = [(0, 0, 0)] * (n * n)
    cx = cy = n / 2

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

            # ---- the horn glyph -------------------------------------
            ux = (x - cx) / (n * art)
            uy = (y - cy) / (n * art)
            ink = 0.0

            # mouth: a trapezoid opening to the right
            if -0.30 <= ux <= 0.02:
                half = lerp(0.085, 0.265, (ux + 0.30) / 0.32)
                if abs(uy) <= half:
                    ink = 1.0
            # throat: the small rectangle feeding it
            if -0.40 <= ux <= -0.28 and abs(uy) <= 0.085:
                ink = 1.0

            # three wavefronts leaving the mouth
            rr = math.hypot(ux - 0.02, uy)
            ang = math.degrees(math.atan2(uy, ux - 0.02))
            if abs(ang) < 52:
                for band in (0.115, 0.205, 0.295):
                    if abs(rr - band) < 0.0225:
                        ink = 1.0

            if ink > 0:
                col = (244, 247, 248)

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
