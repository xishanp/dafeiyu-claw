# 白色小花从枯枝上飘下来，落在青蓝色的水面上，荡开一圈圈涟漪
# 生成本鱼自己的那版，存成 gif
import math, random
from PIL import Image, ImageDraw, ImageFilter

W, H = 480, 640
FRAMES = 72
FPS = 20
random.seed(20261103)

TOP = (24, 52, 168)      # 上头的深蓝
BOT = (92, 150, 232)     # 水面的浅蓝
HORIZON = int(H * 0.42)  # 水天线

def base_image():
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        if y < HORIZON:
            t = y / HORIZON
            c = tuple(int(TOP[i] + (BOT[i] - TOP[i]) * t * 0.7) for i in range(3))
        else:
            t = (y - HORIZON) / (H - HORIZON)
            c = tuple(int(BOT[i] * (1 - 0.5 * t) + 8 * t) for i in range(3))
        d.line([(0, y), (W, y)], fill=c)
    return img

# 枯枝：从画面左上伸进来
def draw_branch(d, x0, y0, angle, length, width, depth=0):
    if depth > 5 or length < 8:
        return []
    tips = []
    x1 = x0 + math.cos(angle) * length
    y1 = y0 - math.sin(angle) * length
    d.line([(x0, y0), (x1, y1)], fill=(18, 22, 30), width=max(1, int(width)))
    tips.append((x1, y1))
    for k in (-1, 1):
        na = angle + k * random.uniform(0.3, 0.7)
        tips += draw_branch(d, x1, y1, na, length * random.uniform(0.55, 0.75),
                            width * 0.62, depth + 1)
    return tips

def petal(size):
    s = max(2, int(size))
    im = Image.new("RGBA", (s * 4, s * 4), (0, 0, 0, 0))
    dd = ImageDraw.Draw(im)
    for i in range(5):
        a = i * 2 * math.pi / 5
        cx = s * 2 + math.cos(a) * s * 0.7
        cy = s * 2 + math.sin(a) * s * 0.7
        r = s * 0.62
        dd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 235))
    dd.ellipse([s * 2 - s * 0.35, s * 2 - s * 0.35, s * 2 + s * 0.35, s * 2 + s * 0.35],
               fill=(250, 246, 210, 240))
    return im.filter(ImageFilter.GaussianBlur(0.6))

def main():
    bg = base_image()
    d0 = ImageDraw.Draw(bg)
    tips = []
    tips += draw_branch(d0, -10, 120, -0.55, 90, 4)
    tips += draw_branch(d0, -30, 40, -0.95, 70, 3)
    tips = [(x, y) for (x, y) in tips if 0 <= x < W and 0 <= y < H]

    # 花瓣：从枝头落下来
    ps = []
    for i in range(48):
        x, y = random.choice(tips)
        ps.append(dict(
            x=x + random.uniform(-8, 8), y=y + random.uniform(-8, 8),
            ph=random.uniform(0, 6.28),
            vy=random.uniform(14, 34),
            amp=random.uniform(6, 18),
            size=random.uniform(3.2, 6.5),
            t=-random.uniform(0, 7),
            land=None,
        ))

    ripples = []
    frames = []
    dt = 1.0 / FPS

    for f in range(FRAMES):
        img = bg.copy().convert("RGBA")
        dr = ImageDraw.Draw(img, "RGBA")

        # 水面细波纹：一条条短横线，错开摆，别连成整条带子
        for row in range(HORIZON + 46, H, 33):
            off = int(math.sin(f / 11 + row * 0.13) * 9)
            seg = 18 + (row % 4) * 6
            step = seg * 5 + (row * 7) % 23
            for x in range(-seg + off, W + seg, step):
                dr.line([(x, row), (x + seg, row)],
                        fill=(255, 255, 255, 5 + (row % 3) * 3), width=1)

        # 涟漪
        for rp in ripples[:]:
            age = f - rp["born"]
            if age > 34:
                ripples.remove(rp)
                continue
            r = 3 + age * 1.5
            a = max(0, int(70 * (1 - age / 34)))
            dr.ellipse([rp["x"] - r, rp["y"] - r * 0.32,
                        rp["x"] + r, rp["y"] + r * 0.32],
                       outline=(255, 255, 255, a), width=1)

        for p in ps:
            p["t"] += dt
            if p["t"] < 0:
                continue
            if p["land"] is not None:
                # 落水之后慢慢沉下去，然后重生在枝头
                age = f - p["land"]
                if age > 40:
                    x, y = random.choice(tips)
                    p.update(x=x, y=y, t=0, land=None,
                             ph=random.uniform(0, 6.28), vy=random.uniform(14, 34))
                continue

            p["y"] += p["vy"] * dt
            p["x"] += math.sin(p["t"] * 0.9 + p["ph"]) * 6 * dt
            x = p["x"] + math.sin(p["t"] * 2.1 + p["ph"]) * p["amp"] * 0.35
            y = p["y"]

            # 掉到水面以下就落水
            if y > HORIZON + 20:
                p["land"] = f
                ripples.append(dict(x=x, y=y, born=f))
                continue

            sp = petal(p["size"])
            sp = sp.rotate(math.degrees(math.sin(p["t"] * 3 + p["ph"]) * 0.6))
            img.alpha_composite(sp, (int(x - sp.width / 2), int(y - sp.height / 2)))

        frames.append(img.convert("RGB"))

    frames[0].save("toys/petals.gif", save_all=True, append_images=frames[1:],
                   duration=int(1000 / FPS), loop=0, optimize=True)
    print("done", len(frames))

main()
