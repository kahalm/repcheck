"""Erzeugt die Extension-Icons (16/48/128 px) in ./icons/.

Logo: weisser Turm (Rook) auf gruenem Hintergrund — passt zur RookHub-Welt.
Der Turm wird aus geometrischen Primitiven (Polygone + Rechtecke) gezeichnet,
nicht als Font-Glyphe — das gibt scharfe Kanten in allen drei Groessen.

Voraussetzung: Pillow (`pip install pillow`).
Re-Run, wann immer Du die Icons aenderst — die PNGs sollten committet sein.
"""

from pathlib import Path
from PIL import Image, ImageDraw

# Farben
BG = (76, 175, 80, 255)        # mat-green 500
FG = (255, 255, 255, 255)
SHADOW = (0, 0, 0, 60)
SIZES = [16, 48, 128]
OUT = Path(__file__).parent / "icons"


def rook_path(size: int):
    """Liefert eine Liste von Pillow-Zeichenoperationen fuer einen Turm,
    normalisiert auf die gegebene Bitmap-Groesse. Form (x,y in 0..1):

    Zinnen (oben): drei Bloecke + zwei Spalten dazwischen, klassisch 5-7-5
    Hals       : Trapez darunter
    Brust      : breiter Block
    Sockel     : breite Basis
    """
    # Koordinaten in 0..1 (links/oben = 0,0)
    # 5 Zinnen, je 12% breit, mit 4% Spalten dazwischen.
    crenel_w = 0.12
    crenel_h = 0.18
    crenel_y = 0.10
    crenels_x = [0.13, 0.31, 0.49, 0.67]  # 4 Spalten zwischen 5 Zinnen
    crenel_gap = 0.06   # Tiefe der Aussparungen
    # Brust (mittlerer breiter Block)
    chest = (0.15, crenel_y + crenel_h, 0.85, 0.62)
    # Hals (zwischen Brust und Sockel) — gewollt schmaler
    neck = (0.25, 0.55, 0.75, 0.72)
    # Sockel (basis)
    base = (0.08, 0.78, 0.92, 0.92)
    # untere Standfläche
    foot = (0.05, 0.88, 0.95, 0.95)

    def s(coord):
        return tuple(int(c * size) for c in coord)

    polys = []
    # Hauptkopf (oben durchgehend) — 0..1 Breite, von crenel_y bis crenel_y+crenel_h
    polys.append(("rect", s((0.10, crenel_y, 0.90, crenel_y + crenel_h))))
    # Aussparungen aus dem Kopf (Zinnen-Negative)
    for x in crenels_x:
        polys.append(("cutout", s((x, crenel_y, x + crenel_gap, crenel_y + crenel_h * 0.7))))
    polys.append(("rect", s(chest)))
    polys.append(("rect", s(neck)))
    polys.append(("rect", s(base)))
    polys.append(("rect", s(foot)))
    return polys


def render(size: int) -> Image.Image:
    """Quadratisches Icon — gruener Hintergrund, weisser Turm zentriert."""
    img = Image.new("RGBA", (size, size), BG)
    draw = ImageDraw.Draw(img)

    ops = rook_path(size)
    # Erst alles Weiss zeichnen.
    for kind, box in ops:
        if kind == "rect":
            draw.rectangle(box, fill=FG)
    # Dann die Zinnen-Aussparungen wieder mit Hintergrund-Farbe ueberzeichnen.
    for kind, box in ops:
        if kind == "cutout":
            draw.rectangle(box, fill=BG)

    return img


def main():
    OUT.mkdir(exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon{size}.png"
        render(size).save(path, "PNG", optimize=True)
        print(f"wrote {path.relative_to(OUT.parent)} ({size}x{size})")


if __name__ == "__main__":
    main()
