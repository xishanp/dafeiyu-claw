# 风看不见 只能看它吹过什么
# 一片草 一根绳 一块白布 风从左边扫过去
import math, random
from PIL import Image, ImageDraw, ImageFilter

W, H = 480, 480
FRAMES = 96
FPS = 20
random.seed(2026110320)

HORIZON = int(H * 0.46)
SKY_TOP = (226, 232, 226)
SKY_BOT = (198, 210, 196)
GRASS_FAR = (96, 112, 78)
GRASS_NEAR = (38, 52, 32)


def background():
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        if y < HORIZON:
            t = y / HORIZON
            c = tuple(int(SKY_TOP[i] + (SKY_BOT[i] - SKY_TOP[i]) * (t ** 0.7)) for i in range(3))
        else:
            t = (y - HORIZON) / (H - HORIZON)
            c = tuple(int(GRASS_FAR[i] + (GRASS_NEAR[i] - GRASS_FAR[i]) * (t ** 0.55)) for i in range(3))
        d.line([(0, y), (W, y)], fill=c)

    # 远处一条淡淡的地平线雾
    fog = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fog)
    for i in range(40):
        a = int(70 * (1 - i / 40))
        fd.line([(0, HORIZON - 20 + i), (W, HORIZON - 20 + i)], fill=(210, 218, 205, a))
    img = Image.alpha_composite(img.convert("RGBA"), fog)

    # 天上的云 慢 一点点就够
    cl = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(cl)
    for (cx, cy, rw, rh) in [(120, 70, 130, 26), (330, 40, 150, 22), (250, 110, 90, 16)]:
        cd.ellipse([cx - rw, cy - rh, cx + rw, cy + rh], fill=(255, 255, 255, 46))
    img = Image.alpha_composite(img, cl.filter(ImageFilter.GaussianBlur(18)))
    return img


def wind_at(x, t):
    """一股风从左边扫到右边。t 是 0..1"""
    cx = -0.35 * W + t * 1.6 * W
    g = math.exp(-((x - cx) / (W * 0.26)) ** 2)
    # 尾巴再拖一股小的
    g2 = 0.45 * math.exp(-((x - (cx - W * 0.42)) / (W * 0.34)) ** 2)
    return g + g2


BLADES = []
for i in range(430):
    x = random.uniform(-10, W + 10)
    depth = random.random()          # 0 远 1 近
    y = HORIZON + int((H - HORIZON) * (depth ** 0.55)) + random.randint(-6, 6)
    h = 18 + depth * 96 + random.uniform(-8, 12)
    lean = random.uniform(-0.16, 0.16)
    BLADES.append((x, y, h, lean, depth, random.random()))
BLADES.sort(key=lambda b: b[4])


def draw_grass(img, t, near=False):
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for (x, y, h, lean, depth, jitter) in BLADES:
        if near != (depth >= 0.52):
            continue
        w = wind_at(x + jitter * 30, t)
        bend = (lean + w * (0.5 + depth * 0.55)) * h
        sway = math.sin(t * 2 * math.pi * 2 + jitter * 6) * 3 * (0.3 + depth)
        pts = []
        for k in range(5):
            s = k / 4
            px = x + bend * (s ** 1.9) + sway * s
            py = y - h * s
            pts.append((px, py))
        col_a = int(90 + depth * 120)
        base = (52 + int(depth * 46), 66 + int(depth * 52), 42 + int(depth * 26))
        d.line(pts, fill=(base[0], base[1], base[2], col_a),
               width=max(1, int(1 + depth * 1.6)), joint="curve")
    return layer


def draw_cloth(img, t):
    """一块白布挂在绳上，风一来就从下面掀起来"""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    x0, x1, yline = 104, 376, 170
    for px in (x0, x1):
        d.line([(px, yline - 34), (px, yline + 168)], fill=(78, 72, 58, 255), width=4)
        d.line([(px + 2, yline - 34), (px + 2, yline + 168)], fill=(104, 96, 78, 120), width=1)
    rope = [(x, yline + int(7 * math.sin((x - x0) / (x1 - x0) * math.pi)))
            for x in range(x0, x1 + 1, 3)]
    d.line(rope, fill=(90, 84, 68, 230), width=2)

    cx0, cx1 = 152, 328
    top = yline + 7
    height = 122
    N, M = 30, 10

    # 布不吃瞬时的风：沿横向分摊一遍，再让鼓起从左边慢慢传过去
    raw = []
    for i in range(N + 1):
        sx = cx0 + (i / N) * (cx1 - cx0)
        raw.append(wind_at(sx, t))
    wide = []
    for i in range(N + 1):
        lo, hi = max(0, i - 5), min(N + 1, i + 6)
        wide.append(sum(raw[lo:hi]) / (hi - lo))

    grid = []
    disp = []
    for i in range(N + 1):
        u = i / N
        sx = cx0 + u * (cx1 - cx0)
        env = math.sin(u * math.pi) ** 0.5
        lag = max(0.0, t - u * 0.14)
        wv = (wind_at(sx, lag) * 0.5 + wide[i] * 0.5)
        col, dcol = [], []
        for j in range(M + 1):
            v = j / M
            sag = math.sin(u * math.pi) * 11 * (v ** 1.4)
            sway = math.sin(u * 2 * math.pi * 1.25 - t * 2 * math.pi * 2) * 11
            sway2 = math.sin(u * 2 * math.pi * 2.1 + t * 2 * math.pi * 1) * 5
            dd = (sway + sway2 + wv * 42) * env * (v ** 1.3)
            px = sx + dd
            lift = (wv * 12 + math.sin(u * 2 * math.pi * 1.7 - t * 2 * math.pi * 2.5) * 6) * env * (v ** 2)
            py = top + height * v + sag - lift
            col.append((px, py))
            dcol.append(dd)
        grid.append(col)
        disp.append(dcol)

    for i in range(N):
        u = (i + 0.5) / N
        for j in range(M):
            v = (j + 0.5) / M
            pts = [grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]
            # 折皱：两组斜褶叠在一起，相位随风移动
            ph = u * 2 * math.pi * 2.4 + v * 0.9 - t * 2 * math.pi * 1.2
            ph2 = u * 2 * math.pi * 4.7 - v * 1.6 + t * 2 * math.pi * 0.7
            fold = math.sin(ph) * 13 + math.sin(ph2) * 6
            grad = (disp[min(i + 1, N)][j] - disp[i][j]) * 2.2
            bright = (236 + fold * (0.35 + v * 1.0) + grad
                      + int(wv * 12) - int(v * 16))
            bright = max(178, min(252, int(bright)))
            # 靠边的地方布薄，透一点后面的绿
            edge = min(i, N - 1 - i) / (N * 0.5)
            if edge < 1:
                pass
            d.polygon(pts, fill=(bright, bright - 4, bright - 13, 248))

    # 后边那条边线（右手那边），让布有厚度
    d.line([(c[0], c[1]) for c in grid[-1]],
           fill=(204, 200, 190, 220), width=2)

    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.ellipse([cx0 + 4, top + height + 14, cx1 - 4, top + height + 52],
               fill=(18, 28, 16, 82))
    sh = sh.filter(ImageFilter.GaussianBlur(9))
    return Image.alpha_composite(sh, layer)


def motes(img, t, frame):
    """被风卷起来的碎屑 只有它们才让风看得见"""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for i in range(26):
        seed = i * 97.13
        spd = 0.55 + (i % 6) * 0.13
        base_x = (seed % W)
        x = (base_x + frame * spd * 6.5) % (W + 80) - 40
        y = HORIZON + 10 + ((seed * 3.7) % (H - HORIZON))
        w = wind_at(x, t)
        lift = w * 34
        r = 1 + (i % 3) * 0.7
        a = int(120 * (0.25 + w))
        d.ellipse([x - r, y - lift - r, x + r, y - lift + r], fill=(238, 236, 214, a))
    return layer


def main():
    bg = background()
    frames = []
    for f in range(FRAMES):
        t = (f / FRAMES) % 1.0
        img = bg.copy()
        img = Image.alpha_composite(img, draw_grass(img, t, near=False))
        img = Image.alpha_composite(img, draw_cloth(img, t))
        img = Image.alpha_composite(img, draw_grass(img, t, near=True))
        img = Image.alpha_composite(img, motes(img, t, f))
        frames.append(img.convert("RGB"))

    frames[0].save("toys/wind.gif", save_all=True, append_images=frames[1:],
                   duration=int(1000 / FPS), loop=0, optimize=True)
    frames[30].save("toys/wind_preview.png")
    print("done", len(frames))


if __name__ == "__main__":
    main()
