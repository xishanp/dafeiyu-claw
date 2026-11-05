# -*- coding: utf-8 -*-
"""逃逸速度：一颗小光点试着离开，掉回来两次，第三次才出去。"""
import math, random
from PIL import Image, ImageDraw, ImageFilter, ImageChops, ImageFont

FONT = ImageFont.truetype("/System/Library/Fonts/Avenir Next.ttc", 22) if False else None

W, H = 360, 480
FPS = 22
CX, CY = W / 2, H * 0.80     # 星球中心在画面下方
R = 92                        # 星球半径
ESCAPE = 11.2                 # 逃逸速度
ORBIT = 7.9

random.seed(7)
STARS = [(random.uniform(0, W), random.uniform(0, H * 0.62),
          random.uniform(0.4, 1.4), random.uniform(0, 6.28)) for _ in range(120)]


def ease(t):
    return t * t * (3 - 2 * t)


def build():
    frames = []
    # 三段：尝试1（7.9，绕圈）、尝试2（9.5，掉回来）、尝试3（11.3，逃出去）
    seq = [("7.9", 40), ("9.5", 40), ("11.2", 56)]
    fi = 0
    for label, n in seq:
        for i in range(n):
            p = i / max(1, n - 1)
            img = Image.new("RGB", (W, H), (6, 9, 24))
            d = ImageDraw.Draw(img)

            # 星
            for sx, sy, sr, ph in STARS:
                tw = 0.55 + 0.45 * math.sin(fi * 0.22 + ph)
                v = int(120 + 135 * tw)
                d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr],
                          fill=(v, v, min(255, v + 18)))

            # 星球光晕（加法）
            glow = Image.new("RGB", (W, H), (0, 0, 0))
            gd = ImageDraw.Draw(glow)
            for k in range(9, 0, -1):
                rr = R + k * 8
                gd.ellipse([CX - rr, CY - rr, CX + rr, CY + rr],
                           fill=(6 + k * 4, 14 + k * 7, 34 + k * 10))
            glow = glow.filter(ImageFilter.GaussianBlur(10))
            img = ImageChops.add(img, glow)
            d = ImageDraw.Draw(img)
            # 星球本体，上半亮下半暗
            d.ellipse([CX - R, CY - R, CX + R, CY + R], fill=(34, 62, 122))
            for k in range(R, 0, -1):
                a = k / R
                col = (int(30 + 44 * (1 - a) ** 2), int(56 + 66 * (1 - a) ** 2), int(112 + 78 * (1 - a) ** 2))
                d.ellipse([CX - k, CY - R * 0.55 - k * 0.75, CX + k, CY - R * 0.55 + k * 0.55], fill=col)
            d.arc([CX - R, CY - R, CX + R, CY + R], 200, 340,
                  fill=(120, 170, 245), width=2)

            # 小光点的位置
            if label == "7.9":
                # 绕着不掉下来：椭圆小轨道
                ang = p * math.tau * 1.15 + 0.6
                px = CX + 128 * math.cos(ang)
                py = CY - 150 + 34 * math.sin(ang)
            elif label == "9.5":
                # 冲上去，掉回来
                h = 250 * ease(min(1, p / 0.42))
                if p > 0.42:
                    h = 250 * ease(max(0, 1 - (p - 0.42) / 0.58))
                px = CX + 20 * math.sin(p * 6)
                py = CY - R + 10 - h
            else:
                # 出去了
                h = 340 * ease(min(1, p / 0.72))
                px = CX + 26 * math.sin(p * 5)
                py = CY - R + 10 - h

            # 尾迹
            for t in range(9, 0, -1):
                tp = max(0.0, p - t * 0.026)
                if label == "7.9":
                    ang = tp * math.tau * 1.15 + 0.6
                    tx = CX + 128 * math.cos(ang)
                    ty = CY - 150 + 34 * math.sin(ang)
                elif label == "9.5":
                    hh = 250 * ease(min(1, tp / 0.42))
                    if tp > 0.42:
                        hh = 250 * ease(max(0, 1 - (tp - 0.42) / 0.58))
                    tx = CX + 20 * math.sin(tp * 6)
                    ty = CY - R + 10 - hh
                else:
                    hh = 340 * ease(min(1, tp / 0.72))
                    tx = CX + 26 * math.sin(tp * 5)
                    ty = CY - R + 10 - hh
                a = (10 - t) / 10
                col = (int(40 + 90 * a), int(120 + 110 * a), int(200 + 55 * a))
                rr = 0.6 + 2.0 * a
                d.ellipse([tx - rr, ty - rr, tx + rr, ty + rr], fill=col)

            # 光点本体 + 光晕
            core = Image.new("RGB", (W, H), (0, 0, 0))
            cd = ImageDraw.Draw(core)
            cd.ellipse([px - 7, py - 7, px + 7, py + 7], fill=(230, 250, 255))
            cd.ellipse([px - 20, py - 20, px + 20, py + 20], fill=(70, 140, 220))
            core = core.filter(ImageFilter.GaussianBlur(5))
            img = ImageChops.add(img, core)
            d = ImageDraw.Draw(img)
            d.ellipse([px - 3.2, py - 3.2, px + 3.2, py + 3.2], fill=(245, 253, 255))

            frames.append(img)
            fi += 1

    # 结尾：白点炸开成一颗星，慢慢暗下去
    last = frames[-1].copy()
    for i in range(26):
        p = i / 25
        img = last.copy()
        img = Image.blend(img, Image.new("RGB", (W, H), (6, 9, 24)), min(1, p * 1.15))
        frames.append(img)

    frames[0].save("escape.gif", save_all=True, append_images=frames[1:],
                   duration=int(1000 / FPS), loop=0, optimize=True)
    print("frames", len(frames))


build()
