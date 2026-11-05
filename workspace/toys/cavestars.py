import math, random, os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

W, H = 640, 800
WATER = 470
FRAMES = 60
random.seed(7)

# 矿点：一条斜的星河带，带内密，带外稀
STARS = []
while len(STARS) < 210:
    x = random.uniform(8, W-8)
    y = random.uniform(4, WATER-30)
    center = W*0.44 + (y - 250)*0.16
    d = abs(x - center)
    if d > 200:
        continue
    w = 1.0 if d < 60 else max(0.0, 1 - (d-60)/140) * 0.6
    if random.random() > w:
        continue
    STARS.append((x, y, random.uniform(0.6, 2.5), random.uniform(0, 6.28), random.random() < 0.25))

def make_sky(t):
    img = Image.new("RGB", (W, WATER), (4, 6, 12))

    cx = LAMP_X - 60 + math.sin(t*math.tau)*70
    cy = WATER - 92

    glowbuf = Image.new("RGB", (W, WATER), (0, 0, 0))
    gd = ImageDraw.Draw(glowbuf)
    corebuf = Image.new("RGB", (W, WATER), (0, 0, 0))
    kd = ImageDraw.Draw(corebuf)

    for (x, y, r, ph, warm) in STARS:
        dist = math.hypot(x-cx, y-cy)
        near = max(0.0, 1 - dist/260)
        lit = 0.16 + 0.84*near*near
        tw = 0.55 + 0.45*math.sin(t*math.tau*2 + ph)
        a = lit * (0.45 + 0.55*tw)
        if a < 0.03:
            continue
        rr = r*2.6
        v = int(255*a)
        col = (v, int(v*0.93), int(v*0.72)) if warm else (int(v*0.88), int(v*0.96), v)
        gd.ellipse([x-rr, y-rr, x+rr, y+rr], fill=col)
        kd.ellipse([x-r*0.55, y-r*0.55, x+r*0.55, y+r*0.55], fill=(v, v, int(v*0.95)))

    g = glowbuf.filter(ImageFilter.GaussianBlur(7))
    g = Image.eval(g, lambda v: int(v*0.75))
    img = ImageChops.add(img, g)
    img = ImageChops.add(img, corebuf)

    # 洞顶穹拱：只压四角，别把星星压没
    vig = Image.new("L", (W, WATER), 255)
    vd = ImageDraw.Draw(vig)
    vd.rectangle([0, 0, W, WATER], fill=0)
    vd.ellipse([-70, -140, W+70, WATER*1.06], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(52))
    vig = vig.point(lambda v: min(255, int(v*1.35)))
    dark = Image.new("RGB", (W, WATER), (3, 4, 9))
    img = Image.composite(img, dark, vig)
    return img

LAMP_X = W*0.5 - 206 + 20

frames = []
for f in range(FRAMES):
    t = f / FRAMES
    img = make_sky(t)

    # 先把岸上的人画进上面这一层，倒影才会有人
    top = img.copy()
    pd = ImageDraw.Draw(top, "RGBA")
    bx, by = W*0.5 - 206, WATER - 4
    cloth = (30, 39, 60, 255)
    skin = (44, 55, 78, 255)
    hair = (14, 19, 30, 255)
    # 腿
    pd.line([bx-7, by-86, bx-16, by-2], fill=cloth, width=11)
    pd.line([bx+7, by-86, bx+16, by-2], fill=cloth, width=11)
    # 大衣
    pd.polygon([(bx-21, by-4), (bx+21, by-4), (bx+15, by-84), (bx-15, by-84)], fill=cloth)
    # 手臂
    pd.line([bx-17, by-78, bx-22, by-34], fill=cloth, width=8)
    pd.line([bx+17, by-78, bx+21, by-34], fill=cloth, width=8)
    # 脖子
    pd.rectangle([bx-5, by-98, bx+5, by-82], fill=skin)
    # 头
    pd.ellipse([bx-12, by-126, bx+12, by-96], fill=skin)
    # 后脑的头发
    pd.chord([bx-12, by-128, bx+12, by-100], 170, 350, fill=hair)
    # 仰着的下巴
    pd.arc([bx-12, by-126, bx+12, by-96], 20, 160, fill=(58, 72, 100, 255), width=1)
    # 星光勾边（左上）
    rim = (188, 216, 250, 180)
    pd.arc([bx-12, by-126, bx+12, by-96], 165, 262, fill=rim, width=2)
    pd.line([bx-21, by-4, bx-15, by-84], fill=rim, width=2)
    pd.line([bx-15, by-84, bx-5, by-98], fill=rim, width=1)
    pd.line([bx-7, by-86, bx-16, by-2], fill=(140, 172, 214, 110), width=1)

    # 手里那盏灯
    flick = 0.86 + 0.14*math.sin(t*math.tau*3)
    lx, ly = LAMP_X, WATER - 92
    pd.line([bx+21, by-40, lx-4, ly+5], fill=cloth, width=3)
    pd.ellipse([lx-4, ly-6, lx+4, ly+6], fill=(255, 236, 186, 255))

    # 灯的柔光：单独画一层，模糊后叠上去，才不会有同心圆
    halo = Image.new("RGB", (W, H), (0, 0, 0))
    hd = ImageDraw.Draw(halo)
    for k in range(6, 0, -1):
        rr = 15*k*flick
        v = int(255*0.038*k)
        hd.ellipse([lx-rr*1.25, ly-rr, lx+rr*1.25, ly+rr], fill=(v, int(v*0.82), int(v*0.55)))
    halo = halo.filter(ImageFilter.GaussianBlur(26))

    canvas = Image.new("RGB", (W, H), (3, 4, 9))
    canvas.paste(top, (0, 0))
    canvas = ImageChops.add(canvas, halo)
    top = canvas.copy()
    d = ImageDraw.Draw(canvas, "RGBA")

    d.rectangle([0, WATER, W, H], fill=(4, 7, 14))
    d.line([0, WATER, W, WATER], fill=(105, 150, 200, 55), width=1)

    refl = top.crop((0, 0, W, WATER)).transpose(Image.FLIP_TOP_BOTTOM).filter(ImageFilter.GaussianBlur(2.2))
    refl = Image.eval(refl, lambda v: int(v*0.46))
    canvas.paste(refl, (0, WATER))
    d = ImageDraw.Draw(canvas, "RGBA")
    for yy in range(WATER, H, 6):
        d.line([0, yy, W, yy], fill=(3, 4, 9, 42), width=1)

    # 水面：人脚前方荡开的细纹，不起眼，只为了让水像水
    for j in range(3):
        p = (t + j/3) % 1.0
        rr = 10 + p*150
        a = int(34*(1-p))
        if a <= 0:
            continue
        d.arc([bx-rr, WATER-rr*0.10, bx+rr, WATER+rr*0.10], 20, 160,
              fill=(128, 168, 210, a), width=1)
        d.arc([bx-rr*0.8, WATER-rr*0.07, bx+rr*0.8, WATER+rr*0.07], 200, 340,
              fill=(128, 168, 210, int(a*0.6)), width=1)

    # 人在水面上的站脚倒影，压一点
    d.line([bx-16, WATER+4, bx-14, WATER+30], fill=(120, 150, 190, 55), width=4)
    d.line([bx+16, WATER+4, bx+14, WATER+30], fill=(120, 150, 190, 55), width=4)

    frames.append(canvas)

os.makedirs("work", exist_ok=True)
frames[0].save("work/cavestars.png")
frames[0].save("work/cavestars.gif", save_all=True, append_images=frames[1:], duration=110, loop=0)
print("ok", len(frames))
