# -*- coding: utf-8 -*-
"""
prov.py —— 图上的每一个数，都要带一个出身。

为什么有这个东西：
11-05 这一天，本鱼在三个不相干的话题上犯了同一个错——
把「自己算出来的数」画得跟「查到的数」一模一样。

  · 甲地 2024 年插完的日子，是拿「比去年早 6 天」倒推的，
    摆到轴上跟新闻里写的那天没有区别。
  · 某现象的「十二公里」，不是量出来的，是一具占 520 km²、
    边长 22.8、最近邻取一半，11.4 取整。
  · 「一百多万种人生」，那个数还多一个前提（每个路口只能二选一）。

看图的人（包括三天后的自己）分不出哪个是查的。这就是问题。

用法：
    from prov import Point, legend, draw_points

    pts = [
        Point(2025, "6/19", PAIR,   "平原晚报 2025-06-18 原话"),
        Point(2024, "≈6/25", CALC,  "6/19 才机插 4/17，往后推一周"),
        Point(2023, "≈7/2",  GUESS, "再往回推一格"),
    ]

三类，只三类，不许再加：
    PAIR  查到   —— 原文里就写着这个数，能指到一行字
    CALC  算出   —— 从别的数推的，推法要能重算一遍
    GUESS 推的   —— 只有形容词或者印象，没有数

画出来必须一眼分得开：
    PAIR   实心 · 实线 · 描边
    CALC   空心 · 虚线引出
    GUESS  虚线 · 半透明 · 带问号

一条硬规矩：图例不能省。
图例省掉，这张图就等于把所有点都说成同一类——通常就是说成「查到的」。
"""

PAIR, CALC, GUESS = "pair", "calc", "guess"

_LABEL = {PAIR: "查到的", CALC: "算出来的", GUESS: "推的"}
_COLOR = {PAIR: (126, 176, 138), CALC: (216, 172, 100), GUESS: (150, 150, 150)}


class Point:
    """一个要画到图上的数，连同它是怎么来的。"""

    __slots__ = ("x", "label", "kind", "why")

    def __init__(self, x, label, kind, why=""):
        if kind not in _LABEL:
            raise ValueError("kind 只能是 pair / calc / guess，收到 %r" % (kind,))
        self.x = x
        self.label = label
        self.kind = kind
        self.why = why

    @property
    def strength(self):
        """0 = 只能当个方向，1 = 能当结论用。"""
        return {PAIR: 1.0, CALC: 0.6, GUESS: 0.25}[self.kind]

    def __repr__(self):
        return "<Point %s %s %s>" % (self.label, self.kind, self.why)


def audit(points):
    """画之前先过一遍。返回 (能不能当结论用, 提醒的话)。

    「一个查到的点 + 几个算出来的点」可以做趋势；
    「全是推的点」连趋势都不能画，只能画成一个大概的方向。
    """
    if not points:
        return False, "一个点都没有"
    n = {k: sum(1 for p in points if p.kind == k) for k in _LABEL}
    total = len(points)
    if n[PAIR] == 0:
        return False, "一个查到的点都没有（%d 个里 %d 个是推的）——只能画方向，不能画结论" % (total, n[GUESS])
    if n[PAIR] / total < 0.34:
        return False, "只有 %d/%d 是查到的，图上得让算出来的那些明显虚一点" % (n[PAIR], total)
    return True, "查到 %d · 算出 %d · 推的 %d" % (n[PAIR], n[CALC], n[GUESS])


def legend(d, px, F, x, y, vertical=False):
    """画图例。x, y 是左上角。返回画完之后占的高度。"""
    ink = (240, 238, 231)
    items = [(PAIR, "查到的 · 能指到一行原文"),
             (CALC, "算出来的 · 推法能重算"),
             (GUESS, "推的 · 只有形容词")]
    step_x = 260
    for i, (kind, text) in enumerate(items):
        cx = x if vertical else x + i * step_x
        cy = y + (i * 30 if vertical else 0)
        _glyph(d, px, F, cx, cy, kind)
        d.text((px(cx + 22), px(cy - 2)), text, font=F(14), fill=ink)
    return (len(items) * 30) if vertical else 24


def _glyph(d, px, F, cx, cy, kind, r=7):
    """一个小图标，跟图上的点同一种画法。"""
    c = _COLOR[kind]
    if kind == PAIR:
        d.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], fill=c)
    elif kind == CALC:
        d.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], outline=c, width=px(2))
    else:
        d.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], outline=c, width=px(1))
        d.line([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], fill=c, width=px(1))


def draw_points(d, px, F, points, y0, tx, r=8, label_above=True):
    """把一组点画到同一条轴上。tx(x) 给像素横坐标，y0 给基线。"""
    for p in points:
        c = _COLOR[p.kind]
        cx = tx(p.x)
        if p.kind == PAIR:
            d.ellipse([px(cx - r), px(y0 - r), px(cx + r), px(y0 + r)], fill=c)
        elif p.kind == CALC:
            d.ellipse([px(cx - r), px(y0 - r), px(cx + r), px(y0 + r)], outline=c, width=px(3))
        else:
            d.ellipse([px(cx - r), px(y0 - r), px(cx + r), px(y0 + r)], outline=c, width=px(2))
            d.line([px(cx - r), px(y0 + r), px(cx + r), px(y0 - r)], fill=c, width=px(2))
        ly = y0 - r - 30 if label_above else y0 + r + 10
        d.text((px(cx - 26), px(ly)), p.label, font=F(19), fill=c)


def _demo():
    """跑一遍看效果：`python3 tools/prov.py`"""
    from PIL import Image, ImageDraw, ImageFont

    FONT = "/System/Library/Fonts/STHeiti Medium.ttc"
    W, H, S = 1400, 480, 2

    def F(sz):
        return ImageFont.truetype(FONT, int(sz * S), index=0)

    def px(v):
        return int(round(v * S))

    img = Image.new("RGB", (W * S, H * S), (8, 10, 13))
    d = ImageDraw.Draw(img)
    ink, dim = (240, 238, 231), (154, 152, 145)

    d.text((px(90), px(40)), "同一条轴上的五个数，出身不一样", font=F(34), fill=ink)
    d.text((px(90), px(96)), "2022—2025 年甲地水稻插秧的完成时间。只有最左边那个能指到一句原文。", font=F(16), fill=dim)

    y0 = 280
    d.line([px(230), px(y0), px(1250), px(y0)], fill=(70, 72, 76), width=px(2))

    pts = [
        Point(1, "2022 · 6/17", PAIR, "央视 2022-06-17「已基本完成插秧」"),
        Point(2, "2025 · 6/19", PAIR, "只是记者的预计"),
        Point(3, "2024 · ≈6/25", CALC, "6/19 才走了 4/17"),
        Point(4, "2023 · ≈7/2", GUESS, "再往回推一格"),
        Point(5, "2025 · 6/15", PAIR, "正在插"),
    ]
    draw_points(d, px, F, pts, y0, lambda i: 230 + (i - 1) * 255, r=11)

    legend(d, px, F, 90, 370)
    ok, msg = audit(pts)
    d.text((px(90), px(416)), msg, font=F(15), fill=(126, 176, 138) if ok else (208, 104, 88))

    out = "/tmp/prov_demo.png"
    img.resize((W, H), Image.LANCZOS).save(out)
    print(out)


if __name__ == "__main__":
    _demo()
