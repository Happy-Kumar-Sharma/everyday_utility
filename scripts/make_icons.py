"""Draw the app icon with Pillow: assets/icon.png (256), icon-48.png and a multi-size icon.ico.

    python3 scripts/make_icons.py [OUT_DIR]

The design (indigo gradient rounded square, three white tiles and a plus) matches the hand-written assets/icon.svg.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
LIGHT, DARK = (0x81, 0x8C, 0xF8), (0x4F, 0x46, 0xE5)  # app accent: top-left -> bottom-right
ICO_SIZES = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
SS = 4  # supersampling factor for smooth edges


def render(size: int = 256) -> Image.Image:
    """The icon at `size` px, drawn on a 256-unit grid (same coordinates as icon.svg)."""
    big = 256 * SS
    k = SS

    # diagonal gradient: t = (x + y) / 2 across the square
    ramp = Image.linear_gradient("L").resize((big, big))  # vertical 0..255
    diag = Image.blend(ramp, ramp.transpose(Image.Transpose.ROTATE_90), 0.5)  # + horizontal 0..255
    grad = Image.composite(Image.new("RGB", (big, big), DARK), Image.new("RGB", (big, big), LIGHT), diag)

    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((8 * k, 8 * k, 248 * k - 1, 248 * k - 1), radius=52 * k, fill=255)
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)
    for x, y in ((64, 64), (136, 64), (64, 136)):
        d.rounded_rectangle((x * k, y * k, (x + 56) * k - 1, (y + 56) * k - 1), radius=14 * k, fill=white)
    d.rounded_rectangle((136 * k, 156 * k, 192 * k - 1, 172 * k - 1), radius=8 * k, fill=white)  # plus: horizontal
    d.rounded_rectangle((156 * k, 136 * k, 172 * k - 1, 192 * k - 1), radius=8 * k, fill=white)  # plus: vertical
    return img.resize((size, size), Image.Resampling.LANCZOS)


def main(out_dir: Path = ROOT / "assets") -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    icon = render(256)
    paths = [out_dir / "icon.png", out_dir / "icon-48.png", out_dir / "icon.ico"]
    icon.save(paths[0], optimize=True)
    render(48).save(paths[1], optimize=True)
    icon.save(paths[2], sizes=ICO_SIZES)
    return paths


if __name__ == "__main__":
    for p in main(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "assets"):
        print(f"wrote {p}")
