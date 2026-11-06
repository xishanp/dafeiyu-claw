import math
from PIL import Image, ImageDraw

# 24 帧比什么：左边是「一帧只记一个瞬间」，右边是「快门开半帧、把这段时间的光攒起来」。
# 两个摆一起，同一秒里球走的路线一模一样，只有记录方式不同。

W, H = 480, 260
N, SUB = 24, 24
R = 24
FPS, CYCLE = 24, 1.0
WIDTH = W/2 - R - 12
SHUTTER = 0.5            # 180 度快门

BG   = (250, 248, 244)
LINE = (226, 223, 217)
RED  = (240, 80, 100)

def pos(t):
    return W/2 + WIDTH * math.sin(2 * math.pi * t / CYCLE), H // 2

def blank():
    im = Image.new("RGB", (W, H), BG)
    ImageDraw.Draw(im).line([(0, H/2), (W, H/2)], fill=LINE, width=1)
    return im

def sharp(t):
    im = blank()
    x, y = pos(t)
    ImageDraw.Draw(im).ellipse([x-R, y-R, x+R, y+R], fill=RED)
    return im

def shutter(t):
    """覆盖率当 alpha：每个子样本里球占了多少时间，就染多少。"""
    cov = None
    for i in range(SUB):
        tt = t + (i/(SUB-1) - 0.5) * (SHUTTER / FPS)
        x, y = pos(tt)
        layer = Image.new("L", (W, H), 0)
        ImageDraw.Draw(layer).ellipse([x-R, y-R, x+R, y+R], fill=255)
        cov = layer if cov is None else Image.blend(cov, layer, 1.0/(i+1))
    out = blank()
    out.paste(Image.new("RGB", (W, H), RED), (0, 0), cov)
    return out

def tag(im, text):
    ImageDraw.Draw(im).text((10, 10), text, fill=(140, 136, 130))
    return im

frames = []
for i in range(N):
    t = i / FPS
    a = tag(sharp(t),   "1/24  one instant")
    b = tag(shutter(t), "1/48  half-frame")
    c = Image.new("RGB", (W*2+12, H), (255, 255, 255))
    c.paste(a, (0, 0)); c.paste(b, (W+12, 0))
    frames.append(c)

frames[0].save("shutter.gif", save_all=True, append_images=frames[1:],
               duration=int(1000/FPS), loop=0, optimize=True)
for k in (0, 6, 12):
    frames[k].save(f"shutter_check{k}.png")
print("done")
