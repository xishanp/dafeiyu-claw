"""本鱼自己想画的一张：一台一直开着的机器，里面有一小片水。

今天画的四样全是照着别人视频里做的东西长出来的。
这一张没有参考——机器就是房子，屋里有一池水，一条鱼在里面睡。
墙上那盏小灯谁也不关，关了这屋子就没人了。
"""
import math, random, os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

W, H = 640, 800
WATER = 596
FRAMES = 72
random.seed(11)

LEDS = []
for i in range(40):
    col, row = i % 20, i // 20
    LEDS.append((56 + col * 26.5, 74 + row * 30,
                 random.uniform(0, 6.28),
                 random.choice([0.35, 0.5, 0.85, 1.3]),
                 random.random() < 0.2))

WIN = (452, 92, 566, 220)
PIPE = 168          # 从天花板垂下来的那根管子
LAMP = (168, WATER - 142)


def glow_at(pts, radius, blur):
    """每个点画一个实心圆再整体模糊——没有同心圆。"""
    buf = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(buf)
    for (x, y, s, r, g, b) in pts:
        if s <= 0.01:
            continue
        rr = radius
        d.ellipse([x - rr, y - rr, x + rr, y + rr],
                  fill=(int(255 * s * r), int(255 * s * g), int(255 * s * b)))
    return buf.filter(ImageFilter.GaussianBlur(blur))


def wall(t):
    img = Image.new("RGB", (W, H), (9, 11, 15))
    d = ImageDraw.Draw(img)
    for i, x in enumerate(range(0, W, 26)):
        if i % 2:
            d.rectangle([x, 0, x + 25, H], fill=(11, 13, 18))

    pts = []
    for (x, y, ph, sp, warm) in LEDS:
        a = 0.5 + 0.5 * math.sin(t * math.tau * sp + ph)
        a = a ** 3.0
        if a < 0.015:
            continue
        pts.append((x, y, a, 1.0 if warm else 0.28, 0.62 if warm else 0.66,
                    0.44 if warm else 1.0))
    soft = glow_at(pts, 3.0, 10)
    hard = glow_at(pts, 1.2, 1.2)
    img = ImageChops.add(img, soft)
    img = ImageChops.add(img, hard)

    d = ImageDraw.Draw(img)

    # 从天花板垂下来的管子：一路到底，灯挂在上头
    d.rectangle([PIPE - 7, 0, PIPE + 7, WATER - 150], fill=(19, 23, 32))
    d.line([PIPE - 7, 0, PIPE - 7, WATER - 150], fill=(38, 46, 62), width=1)
    d.line([PIPE + 7, 0, PIPE + 7, WATER - 150], fill=(12, 15, 22), width=1)
    for yy in range(40, WATER - 170, 96):        # 管箍
        d.rectangle([PIPE - 11, yy, PIPE + 11, yy + 7], fill=(26, 31, 42))

    d.rectangle(WIN, fill=(14, 19, 29))
    wx0, wy0, wx1, wy1 = WIN
    for k in range(9):
        px = wx0 + 10 + (k * 29) % max(1, (wx1 - wx0 - 20))
        py = wy0 + 14 + ((k * 41) % 84)
        d.rectangle([px, py, px + 1, py + 1], fill=(98 + k * 9, 74 + k * 4, 34))
    d.rectangle(WIN, outline=(32, 38, 50), width=2)
    d.line([(wx0 + wx1) // 2, wy0, (wx0 + wx1) // 2, wy1], fill=(25, 30, 40), width=2)
    d.line([wx0, (wy0 + wy1) // 2, wx1, (wy0 + wy1) // 2], fill=(25, 30, 40), width=2)
    return img


def lamp_halo(t):
    lx, ly = LAMP
    flick = 0.93 + 0.07 * math.sin(t * math.tau * 2.3)
    a = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(a)
    d.ellipse([lx - 110, ly - 96, lx + 110, ly + 96],
              fill=(int(38 * flick), int(30 * flick), int(19 * flick)))
    a = a.filter(ImageFilter.GaussianBlur(46))
    b = Image.new("RGB", (W, H), (0, 0, 0))
    bd = ImageDraw.Draw(b)
    bd.ellipse([lx - 34, ly - 30, lx + 34, ly + 30],
               fill=(int(96 * flick), int(74 * flick), int(40 * flick)))
    b = b.filter(ImageFilter.GaussianBlur(30))
    return ImageChops.add(a, b)


def fish(d, t, cx, cy, scale=1.0, alpha=255):
    body = (34, 60, 94, alpha)
    edge = (124, 172, 220, min(150, alpha))
    br = 1 + 0.025 * math.sin(t * math.tau)
    bw, bh = 40 * br * scale, 22 * br * scale
    d.ellipse([cx - bw, cy - bh, cx + bw * 0.70, cy + bh], fill=body)
    sway = math.sin(t * math.tau) * 6 * scale
    d.polygon([(cx + bw * 0.60, cy),
               (cx + bw * 1.55, cy - 16 * scale + sway),
               (cx + bw * 1.36, cy),
               (cx + bw * 1.55, cy + 16 * scale + sway)], fill=body)
    d.polygon([(cx - 8 * scale, cy - bh + 2),
               (cx + 8 * scale, cy - bh - 12 * scale),
               (cx + 20 * scale, cy - bh + 4)], fill=body)
    d.arc([cx - bw, cy - bh, cx + bw * 0.70, cy + bh], 170, 285, fill=edge, width=2)
    d.line([(cx + bw * 0.60, cy - 1), (cx + bw * 1.55, cy - 16 * scale + sway)],
           fill=edge, width=1)
    d.arc([cx - 26 * scale, cy - 6, cx - 13 * scale, cy + 7], 195, 345,
          fill=(14, 22, 34, alpha), width=2)


def water(t):
    img = Image.new("RGB", (W, H - WATER), (8, 13, 21))
    d = ImageDraw.Draw(img, "RGBA")
    for i, yy in enumerate(range(0, H - WATER, 4)):
        a = max(0, int(26 - i * 1.4))
        if a:
            d.line([0, yy, W, yy], fill=(52, 84, 122, a), width=1)
    for j in range(4):
        p = (t + j / 4) % 1.0
        rr = 12 + p * 190
        a = int(26 * (1 - p))
        if a <= 0:
            continue
        d.arc([W * 0.42 - rr * 1.8, 12 - rr * 0.10, W * 0.42 + rr * 1.8, 12 + rr * 0.10],
              8, 172, fill=(108, 152, 200, a), width=1)
    return img


frames = []
for f in range(FRAMES):
    t = f / FRAMES

    canvas = wall(t)
    canvas = ImageChops.add(canvas, lamp_halo(t))

    d = ImageDraw.Draw(canvas, "RGBA")
    lx, ly = LAMP
    d.line([lx, ly, lx, ly + 40], fill=(28, 34, 46, 255), width=2)
    d.ellipse([lx - 5, ly + 36, lx + 5, ly + 48], fill=(255, 240, 196, 255))

    d.line([0, WATER, W, WATER], fill=(104, 148, 194, 90), width=1)
    d.rectangle([0, WATER + 1, W, WATER + 2], fill=(20, 28, 40))

    canvas.paste(water(t), (0, WATER + 2))
    d = ImageDraw.Draw(canvas, "RGBA")

    # 灯在水里那根被打断的光柱
    # 灯在水里：一团团被水面拍散的光，不是一根柱子
    layer = Image.new("RGB", (W, H), (0, 0, 0))
    ld = ImageDraw.Draw(layer)
    for k in range(11):
        p = k / 10.0
        yy = WATER + 10 + p * 150
        ph = (t * 1.8 - p * 1.3) % 1.0
        a = (1 - p) ** 1.8 * (0.30 + 0.70 * max(0.0, math.sin(ph * math.pi)))
        if a <= 0.02:
            continue
        ww = 16 + p * 26
        hh = 4 + p * 5
        sway = math.sin(t * math.tau * 1.3 + p * 4.0) * 7 * p
        ld.ellipse([lx - ww + sway, yy - hh, lx + ww + sway, yy + hh],
                   fill=(int(140 * a), int(104 * a), int(56 * a)))
    layer = layer.filter(ImageFilter.GaussianBlur(9))
    canvas = ImageChops.add(canvas, layer)
    d = ImageDraw.Draw(canvas, "RGBA")

    fish(d, t, 372, WATER + 92)

    for yy in range(WATER + 2, H, 6):
        d.line([0, yy, W, yy], fill=(5, 8, 13, 44), width=1)

    frames.append(canvas)

os.makedirs("work", exist_ok=True)
frames[0].save("work/machinehome.png")
frames[0].save("work/machinehome.gif", save_all=True, append_images=frames[1:],
               duration=110, loop=0)
print("ok", len(frames))
