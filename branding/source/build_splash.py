"""The Mini App splash icon for BotFather: the rounded Axiom News logo as ONE <path>, one colour.

BotFather rejects an SVG with more than one shape ("include a file with a single path"). So the logo is
flattened: the rounded red square, minus the white bar, plus the red AXIOM letters inside the bar,
minus the NEWS letters. White parts become holes (transparent), red stays. The boolean operations are
done with skia-pathops, so overlapping glyph strokes are merged first and the result has no overlaps;
fill-rule evenodd then draws it exactly. No rect, group, text, transform or stroke; integer coordinates.

  python branding/source/build_splash.py <montserrat-latin-800-normal.woff2>

Writes branding/out/splash-icon.svg and prints its size and element count. Needs fonttools and
skia-pathops (pip, only on the machine that builds).
"""
import re
import sys
from pathlib import Path

import pathops
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_logo import RED, S, outline  # noqa: E402  (same geometry as logo.svg)

OUT = Path(__file__).resolve().parent.parent / "out" / "splash-icon.svg"
SIZE, RADIUS = 1024, 230
K = 0.5522847498  # circle by four cubic curves


def glyphs(font, text, x0, x1, top, bottom):
    """The letters as one merged path, placed exactly as in build_logo.placed (uniform scale + tracking)."""
    _, xmin, xmax, ymin, ymax = outline(font, text)
    k = (bottom - top) / (ymax - ymin)
    tracking = ((x1 - x0) / k - (xmax - xmin)) / (len(text) - 1)
    _, xmin, xmax, ymin, ymax = outline(font, text, tracking)
    tx, ty = x0 - xmin * k, top - ymin * k
    gs, cmap = font.getGlyphSet(), font.getBestCmap()
    path, x = pathops.Path(), 0.0
    for ch in text:
        g = gs[cmap[ord(ch)]]
        g.draw(TransformPen(path.getPen(), (k, 0, 0, -k, k * x + tx, ty)))
        x += g.width + tracking
    return pathops.simplify(path)


def rounded_square():
    p, pen, r, s, c = pathops.Path(), None, RADIUS, SIZE, RADIUS * (1 - K)
    pen = p.getPen()
    pen.moveTo((r, 0)); pen.lineTo((s - r, 0)); pen.curveTo((s - c, 0), (s, c), (s, r))
    pen.lineTo((s, s - r)); pen.curveTo((s, s - c), (s - c, s), (s - r, s))
    pen.lineTo((r, s)); pen.curveTo((c, s), (0, s - c), (0, s - r))
    pen.lineTo((0, r)); pen.curveTo((0, c), (c, 0), (r, 0)); pen.closePath()
    return p


def rect(x, y, w, h):
    p = pathops.Path()
    pen = p.getPen()
    pen.moveTo((x, y)); pen.lineTo((x + w, y)); pen.lineTo((x + w, y + h)); pen.lineTo((x, y + h)); pen.closePath()
    return p


def main(font_path):
    font = TTFont(font_path)
    bar = rect(38 * S, 109 * S, (281 - 38 + 1) * S, (172 - 109 + 1) * S)
    axiom = glyphs(font, "AXIOM", 49 * S, 271 * S, 120 * S, 162 * S)
    news = glyphs(font, "NEWS", 79 * S, 246 * S, 183 * S, 220 * S)
    shape = pathops.op(rounded_square(), bar, pathops.PathOp.DIFFERENCE)
    shape = pathops.op(shape, pathops.op(axiom, bar, pathops.PathOp.INTERSECTION), pathops.PathOp.UNION)
    shape = pathops.op(shape, news, pathops.PathOp.DIFFERENCE)
    pen = SVGPathPen(None)
    shape.draw(pen)
    d = re.sub(r"-?\d+\.\d+", lambda m: str(round(float(m.group()))), pen.getCommands())
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}">'
           f'<path fill="{RED}" fill-rule="evenodd" d="{d}"/></svg>\n')
    OUT.write_text(svg, encoding="utf-8", newline="\n")
    elements = re.findall(r"<(\w+)", svg)
    print(f"wrote {OUT} ({len(svg.encode())} bytes); elements: {elements}")
    assert elements == ["svg", "path"], elements
    assert not re.search(r"transform|stroke|<rect|<g|<text", svg)


if __name__ == "__main__":
    main(sys.argv[1])
