# 白花从枯枝上飘下来，落到青蓝色的水面，荡一圈涟漪再沉下去
# 第二版：枝条不过水面、花瓣落得下去、落水后有浮沉
import math, random
from PIL import Image, ImageDraw, ImageFilter

W, H = 480, 640
FRAMES = 90
FPS = 20
random.seed(20261103)

TOP = (16, 44, 158)
BOT = (74, 132, 214)
HORIZON = int(H * 0.44)

def base_image():
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        if y < HORIZON:
            t = y / HORIZON
            c = tuple(int(TOP[i] + (BOT[i] - TOP[i]) * (t ** 0.8) * 0.85) for i in range(3))
        else:
            t = (y - HORIZON) / (H - HORIZON)
            c = tuple(int(BOT[i] * (1 - 0.55 * t) + 6 * t) for i in range(3))
        d.line([(0, y), (W, y)], fill=c)
    return img

def draw_branch(d, x0, y0, angle, length, width, depth=0):
    if depth > 5 or length < 8:
        return []
    tips = []
    x1 = x0 + math.cos(angle) * length
    y1 = y0 - math.sin(angle) * length
    d.line([(x0, y0), (x1, y1)], fill=(16, 20, 26), width=max(1, int(width)))
    tips.append((x1, y1))
    for k in (-1, 1):
        na = angle + k * random.uniform(0.34, 0.72)
        tips += draw_branch(d, x1, y1, na, length * random.uniform(0.55, 0.75),
                            width * 0.62, depth + 1)
    return tips

def petal(size):
    s = max(2, int(size))
    im = Image.new("RGBA", (s * 4, s * 4), (0, 0, 0, 0))
    dd = ImageDraw.Draw(im)
    for i in range(5):
        a = i * 2 * math.pi / 5
        cx = s * 2 + math.cos(a) * s * 0.72
        cy = s * 2 + math.sin(a) * s * 0.72
        r = s * 0.6
        dd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 238))
    dd.ellipse([s * 2 - s * 0.3, s * 2 - s * 0.3, s * 2 + s * 0.3, s * 2 + s * 0.3],
               fill=(250, 246, 206, 240))
    return im.filter(ImageFilter.GaussianBlur(0.55))

def main():
    bg = base_image()

    # 枝条画在单独一层，水天线以下切掉
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dl = ImageDraw.Draw(layer)
    tips = []
    tips += draw_branch(dl, -10, 120, -0.55, 90, 4)
    tips += draw_branch(dl, -30, 40, -0.95, 70, 3)
    tips = [(x, y) for (x, y) in tips if 0 <= x < W and 0 <= y < HORIZON - 10]
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rectangle([0, 0, W, HORIZON], fill=255)
    bg = bg.convert("RGBA")
    bg.alpha_composite(Image.composite(layer, Image.new("RGBA", (W, H), (0, 0, 0, 0)), mask))

    ps = []
    for i in range(34):
        x, y = random.choice(tips)
        ps.append(dict(
            x=x + random.uniform(-7, 7), y=y + random.uniform(-7, 7),
            ph=random.uniform(0, 6.28),
            vy=random.uniform(30, 62),
            amp=random.uniform(5, 14),
            size=random.uniform(3.2, 6.2),
            t=-random.uniform(0, 8),
            land=None,
            drift=random.uniform(10, 46),
        ))

    ripples = []
    frames = []
    dt = 1.0 / FPS

    for f in range(FRAMES):
        img = bg.copy()
        dr = ImageDraw.Draw(img, "RGBA")

        # 水面细纹
        for row in range(HORIZON + 42, H, 30):
            off = int(math.sin(f / 13 + row * 0.11) * 10)
            seg = 16 + (row % 4) * 7
            step = seg * 5 + (row * 7) % 23
            for x in range(-seg + off, W + seg, step):
                dr.line([(x, row), (x + seg, row)],
                        fill=(255, 255, 255, 6 + (row % 3) * 4), width=1)

        # 涟漪
        for rp in ripples[:]:
            age = f - rp["born"]
            if age > 40:
                ripples.remove(rp)
                continue
            r = 2 + age * 0.95
            a = max(0, int(24 * (1 - age / 40)))
            dr.ellipse([rp["x"] - r, rp["y"] - r * 0.3,
                        rp["x"] + r, rp["y"] + r * 0.3],
                       outline=(255, 255, 255, a), width=1)
            r2 = r * 0.58
            if age > 6:
                dr.ellipse([rp["x"] - r2, rp["y"] - r2 * 0.3,
                            rp["x"] + r2, rp["y"] + r2 * 0.3],
                           outline=(255, 255, 255, int(a * 0.55)), width=1)

        for p in ps:
            p["t"] += dt
            if p["t"] < 0:
                continue

            if p["land"] is not None:
                age = f - p["land"]
                if age > 44:
                    x, y = random.choice(tips)
                    p.update(x=x, y=y, t=0, land=None,
                             drift=random.uniform(10, 46),
                             ph=random.uniform(0, 6.28), vy=random.uniform(30, 62))
                    continue
                sp = petal(p["size"] * max(0.3, 1 - age / 70))
                a = max(0, int(238 * (1 - age / 44)))
                sp.putalpha(sp.split()[3].point(lambda v: int(v * a / 255)))
                px = p["x"] + math.sin(age * 0.10 + p["ph"]) * 2.5
                py = p["y"] + age * 0.5
                img.alpha_composite(sp, (int(px - sp.width / 2), int(py - sp.height / 2)))
                continue

            # 下落：左右飘，越落越慢一点
            p["y"] += p["vy"] * dt
            # 横向真的飘过去，不然全砸在同一个点上
            p["x"] += (math.sin(p["t"] * 1.7 + p["ph"]) * p["amp"] * 0.55
                       + p["drift"]) * dt
            x, y = p["x"], p["y"]

            if y > HORIZON + 2:
                p["land"] = f
                ripples.append(dict(x=x, y=HORIZON + 4, born=f))
                continue

            sp = petal(p["size"])
            sp = sp.rotate(math.degrees(math.sin(p["t"] * 2.4 + p["ph"]) * 0.7))
            img.alpha_composite(sp, (int(x - sp.width / 2), int(y - sp.height / 2)))

        frames.append(img.convert("RGB"))

    frames[0].save("toys/petals.gif", save_all=True, append_images=frames[1:],
                   duration=int(1000 / FPS), loop=0, optimize=True)
    print("done", len(frames))

main()
