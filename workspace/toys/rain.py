# 雨打在玻璃上 不是一直往下掉
# 小的挂在那儿不动 攒大了才滑 滑一段又被卡住 卡住的地方留着水痕
import math, random
from PIL import Image, ImageDraw, ImageFilter

W, H = 480, 600
FRAMES = 170
FPS = 20
random.seed(20261103204)

BG_TOP = (10, 15, 23)
BG_BOT = (30, 42, 52)

LIGHTS = [
    (86, 316, 52, (255, 168, 84), 92),
    (168, 402, 34, (255, 212, 146), 66),
    (312, 274, 44, (128, 184, 255), 58),
    (398, 366, 58, (255, 150, 100), 60),
    (232, 208, 30, (186, 218, 255), 44),
    (444, 486, 38, (255, 196, 124), 48),
    (44, 496, 44, (146, 196, 255), 40),
    (250, 520, 30, (255, 236, 190), 34),
]


def background():
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        c = tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * (t ** 1.3)) for i in range(3))
        d.line([(0, y), (W, y)], fill=c)

    gl = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gl)
    for (cx, cy, r, col, a) in LIGHTS:
        gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col + (a,))
    img = Image.alpha_composite(img.convert("RGBA"), gl.filter(ImageFilter.GaussianBlur(30)))

    # 窗框：一条竖的一条横的，玻璃才成立
    fr = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fr)
    bw = 15
    fd.rectangle([0, 0, W - 1, H - 1], outline=(8, 10, 12, 235), width=bw + 6)
    fd.rectangle([0, 0, W - 1, H - 1], outline=(22, 26, 30, 255), width=bw)
    fd.rectangle([0, int(H * 0.55), W - 1, int(H * 0.55) + 12], fill=(12, 15, 18, 245))
    fd.line([(0, int(H * 0.55)), (W, int(H * 0.55))], fill=(40, 46, 52, 200), width=1)
    fm = fr.filter(ImageFilter.GaussianBlur(0.6))
    img = Image.alpha_composite(img, fm)
    return img


def new_drop(x=None, y=None, r=None):
    r = (random.uniform(4.2, 6.4) if random.random() < 0.18 else random.uniform(1.3, 3.4)) if r is None else r
    return {
        "x": random.uniform(6, W - 6) if x is None else x,
        "y": random.uniform(-30, H * 0.9) if y is None else y,
        "r": r,
        "wob": random.uniform(0, 6.28),
        "hold": 0,
    }


# 水珠爱扎堆：先在几个地方聚一片，再散着铺一点
DROPS = []
for _ in range(16):
    cx, cy = random.uniform(0, W), random.uniform(0, H)
    for _ in range(random.randint(2, 6)):
        DROPS.append(new_drop(
            x=cx + random.gauss(0, 18),
            y=cy + random.gauss(0, 26),
            r=max(1.2, random.gauss(2.2, 0.9))))
for _ in range(30):
    DROPS.append(new_drop())


def draw_drop(layer, x, y, r):
    d = ImageDraw.Draw(layer)
    # 水珠被重力拽成一头圆的形状
    ry = r * 1.22
    d.ellipse([x - r, y - ry, x + r, y + ry], fill=(182, 206, 224, 46))
    d.ellipse([x - r * 0.70, y - ry * 0.78, x + r * 0.34, y + ry * 0.10],
              fill=(232, 242, 250, int(150 + r * 10)))
    d.arc([x - r * 0.96, y - ry * 0.96, x + r * 0.96, y + ry * 0.96],
          start=26, end=154, fill=(244, 250, 255, 168), width=max(1, int(r * 0.40)))


def main():
    bg = background()
    trail = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    blank = Image.new("RGBA", (W, H), (0, 0, 0, 0))

    frames = []
    drops = [dict(d) for d in DROPS]

    for f in range(FRAMES):
        # 旧水痕干得很慢
        trail = Image.blend(trail, blank, 0.010)
        tl = ImageDraw.Draw(trail)

        # 汇合：大的把小的吃掉 变大 也变重
        for dp in drops:
            r = dp["r"]
            for other in drops:
                if other is dp or other["r"] >= r:
                    continue
                if abs(other["y"] - dp["y"]) < r * 1.3 + other["r"] and \
                   abs(other["x"] - dp["x"]) < r + other["r"]:
                    dp["x"] = (dp["x"] * r * r + other["x"] * other["r"] ** 2) / (r * r + other["r"] ** 2)
                    dp["r"] = min(10.0, (r ** 3 + other["r"] ** 3) ** (1 / 3))
                    other["y"] = 10 ** 6
                    r = dp["r"]
        drops[:] = [d for d in drops if d["y"] < H + 12]

        for dp in drops:
            r = dp["r"]
            pull = (r - 4.3) * 1.15
            if dp["hold"] > 0:
                dp["hold"] -= 1
                dp["y"] += 0.05
            elif pull > 0:
                v = pull + 0.55
                dp["y"] += v
                dp["x"] += math.sin(dp["y"] * 0.085 + dp["wob"]) * 0.95
                # 身后的水痕：越滑越淡
                for k in range(3):
                    tl.line([(dp["x"] + (k - 1) * r * 0.35, dp["y"] - v),
                             (dp["x"] + (k - 1) * r * 0.55, dp["y"])],
                            fill=(170, 194, 214, 96 - k * 20), width=1)
                if r > 4.2:
                    tl.line([(dp["x"], dp["y"] - v), (dp["x"], dp["y"])],
                            fill=(196, 214, 230, 78), width=max(3, int(r * 0.7)))
                dp["r"] = min(10.0, r + 0.010)
                # 走着走着被一小块脏东西卡住 停一会儿再往下
                if random.random() < 0.022:
                    dp["hold"] = random.randint(24, 80)
                    dp["r"] = max(2.3, dp["r"] * 0.79)
            else:
                dp["y"] += 0.03
                dp["x"] += math.sin(dp["y"] * 0.04 + dp["wob"]) * 0.05

            if dp["y"] > H + 10:
                dp.update(new_drop(y=random.uniform(-50, -8), r=random.uniform(1.2, 2.6)))
            dp["x"] = min(W - 5, max(5, dp["x"]))

        if f % 6 == 0 and len(drops) < 74:
            drops.append(new_drop(y=random.uniform(-40, H * 0.7)))

        img = bg.copy()
        img = Image.alpha_composite(img, trail)

        drop_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        for dp in sorted(drops, key=lambda d: d["r"]):
            if -24 < dp["y"] < H + 24:
                draw_drop(drop_layer, dp["x"], dp["y"], dp["r"])
        img = Image.alpha_composite(img, drop_layer)
        frames.append(img.convert("RGB"))

    frames[0].save("toys/rain.gif", save_all=True, append_images=frames[1:],
                   duration=int(1000 / FPS), loop=0, optimize=True)
    frames[110].save("toys/rain_preview.png")
    print("done", len(frames))


if __name__ == "__main__":
    main()
