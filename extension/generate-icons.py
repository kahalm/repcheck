"""Erzeugt Placeholder-Icons in 16/48/128 px (RepCheck Logo: weißer Turm auf
dunkelgrünem Quadrat) und schreibt sie in ./icons/.

Voraussetzung: Pillow (`pip install pillow`).

Re-Run, wann immer Du die Icons verbessern willst — die PNGs sollten auch in
git committet sein, damit Store-Builds ohne Python klappen.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# Logo: weißer "R" auf gruenem Quadrat (RepCheck).
BG = (76, 175, 80)         # mat-green 500
FG = (255, 255, 255)
SIZES = [16, 48, 128]
OUT = Path(__file__).parent / "icons"


def find_font():
    """Probiert systemtypische Sans-Bold-Fonts; falls keiner da: Pillow-Default."""
    candidates = [
        # Windows
        "C:\\Windows\\Fonts\\segoeuib.ttf",
        "C:\\Windows\\Fonts\\arialbd.ttf",
        # macOS
        "/System/Library/Fonts/SFNS.ttf",
        # Linux
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    for c in candidates:
        if Path(c).exists():
            return c
    return None


def render(size: int) -> Image.Image:
    """Quadratisches Icon mit zentriertem 'R'."""
    img = Image.new("RGBA", (size, size), BG + (255,))
    draw = ImageDraw.Draw(img)
    font_path = find_font()
    target_h = int(size * 0.78)
    if font_path:
        font = ImageFont.truetype(font_path, target_h)
    else:
        font = ImageFont.load_default()
    text = "R"
    bbox = draw.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    # textbbox kann beim Default-Font null-breite Glyphen liefern → Fallback-Center.
    x = (size - w) // 2 - bbox[0]
    y = (size - h) // 2 - bbox[1]
    draw.text((x, y), text, fill=FG + (255,), font=font)
    return img


def main():
    OUT.mkdir(exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon{size}.png"
        render(size).save(path, "PNG", optimize=True)
        print(f"wrote {path.relative_to(OUT.parent)} ({size}x{size})")


if __name__ == "__main__":
    main()
