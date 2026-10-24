#!/usr/bin/env python3
"""Generate Email Chatter PWA icons with Pillow."""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web', 'icons')
os.makedirs(OUT, exist_ok=True)

BG = (25, 25, 25)
GREEN = (7, 193, 96)
WHITE = (255, 255, 255)


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make_icon(size, maskable=False):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # background rounded square (full-bleed for maskable)
    pad = 0 if maskable else size // 20
    rounded_rect(d, (pad, pad, size - pad, size - pad), size // 8, BG)

    # speech bubble
    if maskable:
        bx0, by0 = int(size * 0.18), int(size * 0.18)
        bx1, by1 = int(size * 0.82), int(size * 0.80)
    else:
        bx0, by0 = int(size * 0.22), int(size * 0.22)
        bx1, by1 = int(size * 0.78), int(size * 0.78)
    r = size // 14
    rounded_rect(d, (bx0, by0, bx1, by1), r, GREEN)
    # tail
    d.polygon([
        (int(size * 0.38), by1),
        (int(size * 0.38), int(size * 0.88)),
        (int(size * 0.52), by1)
    ], fill=GREEN)

    # three dots
    dot_r = size * 0.045
    cy = (by0 + by1) / 2
    for i, cx in enumerate((size * 0.36, size * 0.50, size * 0.64)):
        d.ellipse((cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r), fill=WHITE)
    return img


make_icon(192).save(os.path.join(OUT, 'icon-192.png'))
make_icon(512).save(os.path.join(OUT, 'icon-512.png'))
make_icon(512, maskable=True).save(os.path.join(OUT, 'icon-maskable-512.png'))
print('icons written to', OUT)
