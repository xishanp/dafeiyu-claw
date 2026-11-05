# -*- coding: utf-8 -*-
"""一个核，一圈彩球：用到哪个亮哪个，不用就暗着。"""
import math, random
from PIL import Image, ImageDraw, ImageFilter, ImageChops

W, H = 480, 320
FPS = 20
random.seed(23)

CX, CY = W * 0.5, H * 0.52

# 彩球：极坐标一圈，半径和角度都错开一点
NODES = []
COLORS = [(120, 190, 255), (255, 200, 120), (150, 235, 200),
          (235, 150, 210), (255, 165, 130), (170, 160, 255),
          (140, 230, 245), (230, 225, 150)]
for i in range(8):
    ang = i * (2 * math.pi / 8) + random.uniform(-0.16, 0.16)
    rad = 92 + random.uniform(-16, 26)
    NODES.append({
        "x": CX + math.cos(ang) * rad,
        "y": CY + math.sin(ang) * rad * 0.82,
        "c": COLORS[i],
        "r": random.uniform(2.6, 4.4),
        "ph": random.uniform(0, 6.28),
        "calls": [],          # (开始帧, 持续时间)
    })

TOTAL = 200
# 排好谁在什么时候被叫到：一个接一个，偶尔两个一起
f = 14
while f < TOTAL - 40:
    i = random.randrange(len(NODES))
    dur = random.randint(22, 34)
    NODES[i]["calls"].append((f, dur))
    if random.random() < 0.28:
        j = random.randrange(len(NODES))
        if j != i:
            NODES[j]["calls"].append((f + 3, dur - 8))
    f += random.randint(13, 21)

DUST = [(random.uniform(0, W), random.uniform(0, H),
         random.uniform(0.3, 1.3), random.uniform(0, 6.28)) for _ in range(120)]


def glow(size, color, strength):
    """一张柔光圆斑，返回 RGB 图（加法用）"""
    lay = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(lay)
    for k in range(6, 0, -1):
        rr = size * k / 6
        v = strength * (0.05 + 0.06 * (6 - k))
        d.ellipse([CX if False else 0, 0, 0, 0], fill=(0, 0, 0))  # noop
        d.ellipse([-rr, -rr, rr, rr], fill=(int(color[0] * v),
                                            int(color[1] * v),
                                            int(color[2] * v)))
    return lay


def soft_dot(img, x, y, rad, color, strength, blur=6):
    lay = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(lay)
    for k in range(5, 0, -1):
        rr = rad * k / 5
        v = strength * (0.10 + 0.16 * (5 - k))
        d.ellipse([x - rr, y - rr, x + rr, y + rr],
                  fill=(int(color[0] * v), int(color[1] * v), int(color[2] * v)))
    lay = lay.filter(ImageFilter.GaussianBlur(blur))
    d = ImageDraw.Draw(lay)
    d.ellipse([x - rad * 0.42, y - rad * 0.42, x + rad * 0.42, y + rad * 0.42],
              fill=(min(255, int(color[0] * strength)),
                    min(255, int(color[1] * strength)),
                    min(255, int(color[2] * strength))))
    return lay


def build():
    frames = []
    for fr in range(TOTAL):
        img = Image.new("RGB", (W, H), (6, 8, 18))
        d = ImageDraw.Draw(img)
        # 背景渐变
        for yy in range(0, H, 2):
            k = yy / H
            d.line([(0, yy), (W, yy)],
                   fill=(int(6 + 4 * k), int(8 + 6 * k), int(18 + 12 * k)))

        # 星尘
        for sx, sy, sr, ph in DUST:
            tw = 0.55 + 0.45 * math.sin(fr * 0.06 + ph)
            v = int(24 + 30 * tw)
            d.rectangle([sx, sy, sx + sr, sy + sr], fill=(v, v, int(v * 1.25)))

        acc = Image.new("RGB", (W, H), (0, 0, 0))

        # 连线：先画，淡
        links = Image.new("RGB", (W, H), (0, 0, 0))
        dl = ImageDraw.Draw(links)
        for nd in NODES:
            for (st, dur) in nd["calls"]:
                age = fr - st
                if 0 <= age < dur:
                    k = math.sin(math.pi * age / dur)
                    a = 0.85 * k
                    dl.line([(CX, CY), (nd["x"], nd["y"])],
                            fill=(int(nd["c"][0] * a), int(nd["c"][1] * a),
                                  int(nd["c"][2] * a)), width=1)
                    # 顺着线跑一格的小亮点
                    p = age / dur
                    px = CX + (nd["x"] - CX) * p
                    py = CY + (nd["y"] - CY) * p
                    rr = 2.6
                    dl.ellipse([px - rr, py - rr, px + rr, py + rr],
                               fill=(min(255, int(nd["c"][0] * a * 2.4)),
                                     min(255, int(nd["c"][1] * a * 2.4)),
                                     min(255, int(nd["c"][2] * a * 2.4))))
        links = links.filter(ImageFilter.GaussianBlur(0.9))
        acc = ImageChops.add(acc, links)

        # 核心：慢慢呼吸
        breath = 0.82 + 0.18 * math.sin(fr * 0.085)
        acc = ImageChops.add(acc, soft_dot(img, CX, CY, 46 * breath,
                                           (120, 180, 255), 0.85 * breath, blur=13))
        acc = ImageChops.add(acc, soft_dot(img, CX, CY, 22 * breath,
                                           (185, 222, 255), 1.0 * breath, blur=7))
        acc = ImageChops.add(acc, soft_dot(img, CX, CY, 8,
                                           (245, 252, 255), 1.0, blur=2))
        # 核外面一圈极淡的边界
        ring = Image.new("RGB", (W, H), (0, 0, 0))
        dr = ImageDraw.Draw(ring)
        rr0 = 30 * breath
        dr.ellipse([CX - rr0, CY - rr0, CX + rr0, CY + rr0],
                   outline=(28, 52, 88), width=1)
        acc = ImageChops.add(acc, ring.filter(ImageFilter.GaussianBlur(0.7)))

        # 彩球
        for nd in NODES:
            lit = 0.0
            for (st, dur) in nd["calls"]:
                age = fr - st
                if 0 <= age < dur:
                    lit = max(lit, math.sin(math.pi * age / dur))
            idle = 0.30 + 0.10 * math.sin(fr * 0.07 + nd["ph"])
            s = max(idle, lit)
            rr = nd["r"] * (1 + 0.7 * lit)
            acc = ImageChops.add(acc, soft_dot(img, nd["x"], nd["y"], rr * 3.6,
                                               nd["c"], min(1.0, s * 1.15), blur=5))
            # 被叫到时外面套一圈细环
            if lit > 0.25:
                ring = Image.new("RGB", (W, H), (0, 0, 0))
                dr = ImageDraw.Draw(ring)
                rr2 = nd["r"] * 3.0 + 6 * lit
                dr.ellipse([nd["x"] - rr2, nd["y"] - rr2, nd["x"] + rr2, nd["y"] + rr2],
                           outline=(int(nd["c"][0] * 0.55 * lit),
                                    int(nd["c"][1] * 0.55 * lit),
                                    int(nd["c"][2] * 0.55 * lit)), width=1)
                acc = ImageChops.add(acc, ring.filter(ImageFilter.GaussianBlur(0.8)))

        img = ImageChops.add(img, acc)
        frames.append(img)

    frames[0].save("core.gif", save_all=True, append_images=frames[1:],
                   duration=int(1000 / FPS), loop=0, optimize=True)

    pick = [0, 26, 50, 74, 98, 122, 146, 170]
    sw, sh = 240, 160
    sheet = Image.new("RGB", (sw * 4, sh * 2), (0, 0, 0))
    for i, idx in enumerate(pick):
        sheet.paste(frames[min(idx, len(frames) - 1)].resize((sw, sh)),
                    ((i % 4) * sw, (i // 4) * sh))
    sheet.save("core_strip.png")
    print("frames", len(frames))


build()
