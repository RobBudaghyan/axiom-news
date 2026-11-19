"""Rebuilds the Axiom News logo as a vector (SVG with outlined text, no font needed to display it).

The original exists only as Telegram's 320 px JPEG of @axiom_news_bot's profile photo. Its geometry,
measured on that image and scaled to a 1024 unit square:
  white bar  x 38..281, y 109..172 (of 320)   "AXIOM" in red inside it, cap height 42, width 222
  "NEWS"     x 79..245, y 183..219            white, cap height 37
The typeface is a geometric extra bold sans; Montserrat ExtraBold (SIL Open Font License) matches it.

  python branding/source/build_logo.py <montserrat-latin-800-normal.woff2>

Writes branding/source/logo.svg (the square profile logo), logo-lockup.svg (bar and NEWS only,
transparent, for use on the red background) and logo-paths.json (the raw path data for code).
Needs fonttools and brotli (pip, only on the machine that builds; outputs are committed).
"""
import json
import re
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont

RED = "#b1161c"
S = 1024 / 320          # measured units -> 1024 square
HERE = Path(__file__).resolve().parent


def outline(font, text, tracking=0.0):
    """Path for `text` at 1 unit = 1 font unit, baseline y=0, y down, `tracking` font units between
    letters; returns (d, xmin, xmax, ymin, ymax)."""
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    x = 0
    pen = SVGPathPen(gs)
    bounds = BoundsPen(gs)
    for ch in text:
        name = cmap[ord(ch)]
        t = (1, 0, 0, -1, x, 0)
        gs[name].draw(TransformPen(pen, t))
        gs[name].draw(TransformPen(bounds, t))
        x += gs[name].width + tracking
    xmin, ymin, xmax, ymax = bounds.bounds
    d = re.sub(r"-?\d+\.\d+", lambda m: f"{float(m.group()):.1f}".rstrip("0").rstrip("."), pen.getCommands())
    return d, xmin, xmax, ymin, ymax


def placed(font, text, x0, x1, top, bottom):
    """The text at the cap height top..bottom (uniform scale, glyphs never stretched), with the letter
    spacing that makes it span exactly x0..x1, as a <path>. Returns (d, transform, tracking/em)."""
    _, xmin, xmax, ymin, ymax = outline(font, text)
    k = (bottom - top) / (ymax - ymin)
    tracking = ((x1 - x0) / k - (xmax - xmin)) / (len(text) - 1)
    d, xmin, xmax, ymin, ymax = outline(font, text, tracking)
    tx = x0 - xmin * k
    ty = top - ymin * k
    return d, f"matrix({k:.5f} 0 0 {k:.5f} {tx:.3f} {ty:.3f})", tracking / font["head"].unitsPerEm


def main(font_path):
    font = TTFont(font_path)
    bar = [38 * S, 109 * S, (281 - 38 + 1) * S, (172 - 109 + 1) * S]
    axiom = placed(font, "AXIOM", 49 * S, 271 * S, 120 * S, 162 * S)
    news = placed(font, "NEWS", 79 * S, 246 * S, 183 * S, 220 * S)
    print(f"letter spacing (em): AXIOM {axiom[2]:.3f}, NEWS {news[2]:.3f}")
    bar_s = " ".join(f"{v:.2f}" for v in bar)
    bx, by, bw, bh = bar
    paths = {"viewBox": "0 0 1024 1024", "red": RED, "bar": [round(v, 2) for v in bar],
             "axiom": {"d": axiom[0], "transform": axiom[1]}, "news": {"d": news[0], "transform": news[1]}}
    (HERE / "logo-paths.json").write_text(json.dumps(paths, indent=1), encoding="utf-8")
    (HERE / "logo-paths.js").write_text("window.LOGO = " + json.dumps(paths) + ";\n", encoding="utf-8")
    inner = (f'<rect x="{bx:.2f}" y="{by:.2f}" width="{bw:.2f}" height="{bh:.2f}" fill="#fff"/>\n'
             f'<path fill="{RED}" transform="{axiom[1]}" d="{axiom[0]}"/>\n'
             f'<path fill="#fff" transform="{news[1]}" d="{news[0]}"/>\n')
    (HERE / "logo.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">\n'
        f'<title>Axiom News</title>\n<rect width="1024" height="1024" fill="{RED}"/>\n{inner}</svg>\n', encoding="utf-8")
    # the app icon: the same square with rounded corners (the Mini App loading screen inlines it)
    (HERE / "logo-icon.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
        f'<rect width="1024" height="1024" rx="230" fill="{RED}"/>{inner.replace(chr(10), "")}</svg>\n', encoding="utf-8")
    # the lockup alone, cropped to its own box (bar top to NEWS bottom)
    top, bottom, left, right = by, 220 * S, bx, bx + bw
    (HERE / "logo-lockup.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{left:.2f} {top:.2f} {right - left:.2f} {bottom - top:.2f}">\n'
        f'<title>Axiom News</title>\n{inner}</svg>\n', encoding="utf-8")
    print("wrote logo.svg, logo-lockup.svg, logo-paths.json in", HERE)


if __name__ == "__main__":
    main(sys.argv[1])
