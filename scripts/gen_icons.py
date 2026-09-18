#!/usr/bin/env python3
"""Generate app icons (pure stdlib, no external deps).

Draws a full-bleed gradient square with a white euro glyph, supersampled for
smooth anti-aliased edges. Full-bleed (no transparent corners) so iOS's
home-screen mask and PWA "maskable" masking both round it correctly.
"""
import math
import struct
import zlib
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")

# Gradient endpoints (top -> bottom): indigo -> violet
TOP = (99, 102, 241)     # #6366f1
BOT = (139, 92, 246)     # #8b5cf6
FG = (255, 255, 255)     # glyph


def lerp(a, b, t):
    return a + (b - a) * t


def sample(x, y, n):
    """Return (r,g,b) for the pixel at fractional coords in a unit square [0,1]."""
    # background gradient (by vertical position)
    bg = tuple(lerp(TOP[i], BOT[i], y) for i in range(3))

    # euro glyph geometry in unit space, optically centered
    cx, cy = 0.565, 0.50
    R = 0.27          # outer ring radius
    t = 0.082         # stroke thickness
    dx, dy = x - cx, y - cy
    dist = math.hypot(dx, dy)
    ang = math.degrees(math.atan2(dy, dx))  # -180..180, 0 = right

    cov = 0.0  # glyph coverage 0..1

    # C-shaped ring: ring band, but open on the right (exclude +-40 deg)
    if abs(ang) > 40:
        # smooth band membership
        inner, outer = R - t, R
        d_out = outer - dist
        d_in = dist - inner
        edge = min(d_out, d_in)
        cov = max(cov, clamp01(edge / (1.0 / n) + 0.5))

    # two horizontal crossbars extending left through the ring
    for by in (cy - 0.085, cy + 0.085):
        x0, x1 = cx - R - 0.10, cx + 0.05
        half = t * 0.42
        if x0 <= x <= x1:
            edge = half - abs(y - by)
            cov = max(cov, clamp01(edge / (1.0 / n) + 0.5))

    r = lerp(bg[0], FG[0], cov)
    g = lerp(bg[1], FG[1], cov)
    b = lerp(bg[2], FG[2], cov)
    return int(r + 0.5), int(g + 0.5), int(b + 0.5)


def clamp01(v):
    return 0.0 if v < 0 else (1.0 if v > 1 else v)


def render(size, ss=4):
    """Render an RGBA icon of given size, supersampled by ss for AA."""
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            ar = ag = ab = 0
            for sy in range(ss):
                for sx in range(ss):
                    ux = (px + (sx + 0.5) / ss) / size
                    uy = (py + (sy + 0.5) / ss) / size
                    r, g, b = sample(ux, uy, size)
                    ar += r
                    ag += g
                    ab += b
            k = ss * ss
            row += bytes((ar // k, ag // k, ab // k, 255))
        rows.append(bytes(row))
    return rows


def write_png(path, size, ss=4):
    rows = render(size, ss)
    raw = bytearray()
    for r in rows:
        raw.append(0)  # filter type 0 (none)
        raw += r
    comp = zlib.compress(bytes(raw), 9)

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        c += struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        return c

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", comp) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    print("wrote", path, size, "px")


if __name__ == "__main__":
    write_png(os.path.join(OUT, "icon-1024.png"), 1024)
    write_png(os.path.join(OUT, "icon-512.png"), 512)
    write_png(os.path.join(OUT, "icon-192.png"), 192)
    write_png(os.path.join(OUT, "apple-touch-icon.png"), 180)
    write_png(os.path.join(OUT, "favicon-32.png"), 32)
