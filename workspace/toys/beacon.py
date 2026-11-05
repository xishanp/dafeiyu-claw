# -*- coding: utf-8 -*-
"""平安火：没敌情，每晚也要点一把，让下一站知道自己还在。"""
import math, random
from PIL import Image, ImageDraw, ImageFilter, ImageChops

W, H = 480, 300
FPS = 20
random.seed(11)

NX, NY = 7, 34
STARS = [(random.uniform(0, W), random.uniform(0, H * 0.55),
          random.uniform(0.4, 1.5), random.uniform(0, 6.28)) for _ in range(NX * NY)]

# 山脊线：低处一条起伏
def ridge_y(x):
    return H * 0.66 + 9 * math.sin(x / 61.0) + 5 * math.sin(x / 23.0 + 1.4)


# 烽火台：从左到右沿山脊排，近大远小
TOWERS = []
N = 5
for i in range(N):
    x = 70 + i * 92
    y = ridge_y(x)
    s = 1.0 - i * 0.13
    TOWERS.append((x, y, s))


def tower(d, x, y, s, lit):
    w = 19 * s
    h = 52 * s
    # 墩台（梯形，底宽顶窄）
    body = (54, 40, 34) if lit else (21, 23, 34)
    face = (96, 66, 44) if lit else (28, 31, 44)
    cap = (112, 78, 48) if lit else (30, 33, 46)
    vein = (66, 48, 38) if lit else (17, 19, 29)
    d.polygon([(x - w, y), (x + w, y), (x + w * 0.62, y - h), (x - w * 0.62, y - h)],
              fill=body)
    # 受光面（左亮右暗，火在顶上）
    d.polygon([(x - w, y), (x - w * 0.62, y - h), (x - w * 0.14, y - h), (x - w * 0.22, y)],
              fill=face)
    # 顶上台面 + 垛口
    d.rectangle([x - w * 0.78, y - h - 4 * s, x + w * 0.78, y - h], fill=cap)
    for k in range(3):
        bx = x - w * 0.78 + k * w * 0.62
        d.rectangle([bx, y - h - 7 * s, bx + w * 0.30, y - h - 3 * s], fill=cap)
    # 台身上的横纹（夯土层次）
    for k in range(3):
        yy = y - h * (0.25 + k * 0.22)
        d.line([(x - w * 0.85 + k * 1.2 * s, yy), (x + w * 0.85 - k * 1.2 * s, yy)], fill=vein)
    # 底部接地暗影
    d.ellipse([x - w * 1.15, y - 3 * s, x + w * 1.15, y + 3.5 * s], fill=(8, 10, 18))


def flame_layer(fx, fy, scale, t, heat):
    """一团火，heat 0..1，返回一张 RGB 图（加法用）"""
    lay = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(lay)
    if heat <= 0.01:
        return lay
    # 大光晕
    gr = 38 * scale * (0.85 + 0.25 * heat)
    for k in range(7, 0, -1):
        rr = gr * k / 7
        v = heat * (0.06 + 0.045 * (7 - k))
        d.ellipse([fx - rr, fy - rr * 0.85, fx + rr, fy + rr * 0.7],
                  fill=(int(255 * v), int(150 * v), int(55 * v)))
    lay = lay.filter(ImageFilter.GaussianBlur(5))
    d = ImageDraw.Draw(lay)

    # 火苗：往上冲的几股，越往上越细
    for i in range(9):
        ph = t * 0.75 + i * 1.37
        hh = (32 + 14 * math.sin(ph * 1.15 + i * 0.8)) * scale * heat
        ox = math.sin(ph * 0.8 + i * 2.7) * 6 * scale
        base = (6.2 - i * 0.42) * scale * heat
        bx = fx + ox * 0.55
        by = fy + 2 * scale
        tipy = by - hh
        wob = math.sin(ph * 1.6 + i) * 3.5 * scale
        g = int(120 + 85 * (i % 3) / 2)
        col = (255, g, int(22 + 40 * (math.sin(ph * 1.3) * 0.5 + 0.5)))
        d.polygon([(bx - base, by), (bx + base, by),
                   (bx + base * 0.2 + wob, tipy + hh * 0.35),
                   (bx + wob * 1.2, tipy)],
                  fill=col)
    # 白芯（贴近台面那一团）
    cr = 5.0 * scale * heat
    d.ellipse([fx - cr, fy - cr * 1.2, fx + cr, fy + cr * 0.5], fill=(255, 248, 210))
    return lay.filter(ImageFilter.GaussianBlur(1.1))


def smoke(d, fx, fy, scale, t, amount):
    if amount <= 0.01:
        return
    for i in range(4):
        ph = (t * 0.22 + i * 0.55) % 1.0
        yy = fy - 14 * scale - ph * 58 * scale
        xx = fx + math.sin(t * 0.45 + i * 2.3) * 11 * scale * ph
        a = amount * (1 - ph) ** 2 * 0.16
        rr = (7 + 15 * ph) * scale
        col = (int(150 * a), int(138 * a), int(140 * a))
        d.ellipse([xx - rr, yy - rr, xx + rr, yy + rr], fill=col)


def build():
    frames = []
    total = 150
    # 点火时刻（帧）：一盏接一盏
    ignite = [6 + i * 20 for i in range(len(TOWERS))]

    for f in range(total):
        img = Image.new("RGB", (W, H), (7, 10, 22))
        d = ImageDraw.Draw(img)

        # 夜空渐变
        for yy in range(H):
            k = yy / H
            c = (int(7 + 10 * k), int(10 + 14 * k), int(22 + 20 * k))
            d.line([(0, yy), (W, yy)], fill=c)

        # 星
        for sx, sy, sr, ph in STARS:
            if sy > H * 0.6:
                continue
            tw = 0.5 + 0.5 * math.sin(f * 0.09 + ph)
            v = int(90 + 140 * tw)
            d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=(v, v, min(255, v + 20)))

        # 远山
        for layer, (off, col) in enumerate([(0, (14, 17, 30)), (14, (11, 14, 25))]):
            pts = [(0, H)]
            for x in range(0, W + 8, 8):
                yy = ridge_y(x) + off + 6 * math.sin(x / 37.0 + layer)
                pts.append((x, yy))
            pts.append((W, H))
            d.polygon(pts, fill=col)

        # 山脊主体
        pts = [(0, H)]
        for x in range(0, W + 4, 4):
            pts.append((x, ridge_y(x)))
        pts.append((W, H))
        d.polygon(pts, fill=(10, 12, 22))

        # 台子（先画杆，火后面叠加）
        heats = []
        for i, (tx, ty, s) in enumerate(TOWERS):
            age = f - ignite[i]
            if age < 0:
                heat = 0.0
            elif age < 8:
                heat = age / 8.0
            else:
                heat = 1.0
            heats.append(heat)
            tower(d, tx, ty, s, heat > 0.2)

        # 火（加法合成）
        acc = Image.new("RGB", (W, H), (0, 0, 0))
        for i, (tx, ty, s) in enumerate(TOWERS):
            if heats[i] <= 0.01:
                continue
            flick = 0.86 + 0.14 * math.sin(f * 0.9 + i * 2.0)
            lay = flame_layer(tx, ty - 52 * s, s, f + i * 3.0, heats[i] * flick)
            acc = ImageChops.add(acc, lay)
        img = ImageChops.add(img, acc)

        frames.append(img)

    # 结尾微微暗一点，留一口气
    tail = []
    for i in range(14):
        p = (i + 1) / 14
        fr = frames[-1].copy()
        fr = Image.blend(fr, Image.new("RGB", (W, H), (7, 10, 22)), 0.18 * p)
        tail.append(fr)
    frames += tail

    frames[0].save("beacon.gif", save_all=True, append_images=frames[1:],
                   duration=int(1000 / FPS), loop=0, optimize=True)

    # 预览条
    pick = [0, 30, 55, 80, 105, 130, 145, 160]
    sw, sh = 240, 150
    sheet = Image.new("RGB", (sw * 4, sh * 2), (0, 0, 0))
    for i, idx in enumerate(pick):
        sheet.paste(frames[min(idx, len(frames) - 1)].resize((sw, sh)), ((i % 4) * sw, (i // 4) * sh))
    sheet.save("beacon_strip.png")
    print("frames", len(frames))


build()
