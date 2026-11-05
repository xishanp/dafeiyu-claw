# 一只鲸鱼在水里游，尾巴一摆一摆，气从背上升上去
# 全部用 PIL 画，不靠任何素材
import math, random
from PIL import Image, ImageDraw, ImageFilter, ImageChops

W, H = 480, 480
FRAMES = 72
FPS = 24
random.seed(20261103)

DEEP = (10, 26, 66)
MID = (22, 62, 132)
LIGHT = (74, 150, 214)
BODY = (92, 176, 236)
BELLY = (196, 232, 250)


def background():
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        c = tuple(int(DEEP[i] + (MID[i] - DEEP[i]) * (t ** 0.7)) for i in range(3))
        d.line([(0, y), (W, y)], fill=c)
    return img


def rays(img, phase):
    """从水面上打下来的几道光，慢慢摇"""
    layer = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(layer)
    for i in range(5):
        x = 40 + i * 105 + math.sin(phase + i * 1.3) * 26
        w = 26 + 10 * math.sin(phase * 0.7 + i)
        d.polygon([(x, -40), (x + w, -40), (x + w * 3.2, H), (x + w * 1.4, H)],
                  fill=(38, 82, 140))
    layer = layer.filter(ImageFilter.GaussianBlur(22))
    return ImageChops.add(img, layer)


def whale_layer(phase, size_scale=1.0):
    """单独一层画鲸鱼，好做尾巴摆动"""
    w, h = W * 2, H * 2          # 超采样，缩放下来边缘才平
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = w * 0.5, h * 0.5

    # 身体：一个压扁的椭圆
    bw, bh = 150 * size_scale, 84 * size_scale
    d.ellipse([cx - bw, cy - bh, cx + bw * 0.72, cy + bh], fill=BODY + (255,))
    # 肚子浅一点
    d.ellipse([cx - bw * 0.72, cy + bh * 0.06, cx + bw * 0.6, cy + bh * 0.94], fill=BELLY + (255,))
    # 头往左，嘴那条线
    d.arc([cx - bw * 0.98, cy - bh * 0.5, cx - bw * 0.42, cy + bh * 0.62], 100, 250,
          fill=(60, 128, 196, 255), width=int(3 * size_scale))

    # 尾巴：从身体后面收细成一根柄，再分成上下两瓣鳍
    swing = math.sin(phase) * 0.55
    base_x = cx + bw * 0.66
    stem_x = base_x + 46 * size_scale
    stem_y = cy + math.sin(swing) * 26 * size_scale
    d.polygon([(base_x, cy - 22 * size_scale), (stem_x, stem_y - 9 * size_scale),
               (stem_x, stem_y + 9 * size_scale), (base_x, cy + 22 * size_scale)],
              fill=BODY + (255,))
    up = swing + 0.95
    dn = swing - 0.95
    d.polygon([(stem_x, stem_y - 8 * size_scale),
               (stem_x + math.cos(up) * 58 * size_scale, stem_y + math.sin(up) * 46 * size_scale - 16 * size_scale),
               (stem_x + math.cos(up) * 44 * size_scale, stem_y + math.sin(up) * 60 * size_scale + 10 * size_scale)],
              fill=(72, 158, 224, 255))
    d.polygon([(stem_x, stem_y + 8 * size_scale),
               (stem_x + math.cos(dn) * 58 * size_scale, stem_y + math.sin(dn) * 46 * size_scale + 16 * size_scale),
               (stem_x + math.cos(dn) * 44 * size_scale, stem_y + math.sin(dn) * 60 * size_scale - 10 * size_scale)],
              fill=(72, 158, 224, 255))

    # 胸鳍：贴在身子下侧，半透明
    fin = math.sin(phase * 0.8) * 12 * size_scale
    d.polygon([(cx - bw * 0.05, cy + bh * 0.42),
               (cx + bw * 0.30, cy + bh * 0.86 + fin),
               (cx - bw * 0.24, cy + bh * 0.74 + fin * 0.4)],
              fill=(86, 168, 228, 190))

    # 眼睛
    eye_x, eye_y = cx - bw * 0.62, cy - bh * 0.12
    d.ellipse([eye_x - 9 * size_scale, eye_y - 9 * size_scale,
               eye_x + 9 * size_scale, eye_y + 9 * size_scale], fill=(16, 30, 54, 255))
    d.ellipse([eye_x - 5 * size_scale, eye_y - 6 * size_scale,
               eye_x + 2 * size_scale, eye_y + 1 * size_scale], fill=(255, 255, 255, 235))

    # 头顶喷出来的气，几个小圈往上飘、越飘越大越淡
    for k in range(4):
        r = (7 + k * 6) * size_scale
        yy = cy - bh - (18 + k * 26) * size_scale - math.sin(phase + k * 0.6) * 4
        xx = cx - bw * 0.16 + math.sin(phase * 1.1 + k) * 10 * size_scale
        d.ellipse([xx - r, yy - r, xx + r, yy + r], fill=(226, 244, 255, max(0, 90 - k * 20)))

    return img.resize((W, H), Image.LANCZOS)


def bubbles(frame):
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for i in range(14):
        x0 = (i * 137) % W
        speed = 0.7 + (i % 5) * 0.35
        y = H + 20 - ((frame * speed * 4 + i * 53) % (H + 60))
        x = x0 + math.sin((frame + i * 9) * 0.09) * 9
        r = 2 + (i % 3)
        d.ellipse([x - r, y - r, x + r, y + r], outline=(200, 232, 255, 110), width=1)
    return layer


def main():
    frames = []
    for f in range(FRAMES):
        phase = f / FRAMES * 2 * math.pi
        img = background()
        img = rays(img, phase)
        img = img.convert("RGBA")
        img.alpha_composite(bubbles(f))
        w = whale_layer(phase * 2)
        # 上下轻轻浮
        bob = int(math.sin(phase) * 9)
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.alpha_composite(w, (0, bob))
        img.alpha_composite(canvas)
        frames.append(img.convert("RGB"))

    frames[0].save("toys/whale.gif", save_all=True, append_images=frames[1:],
                   duration=int(1000 / FPS), loop=0, optimize=True)
    print("done", len(frames))


if __name__ == "__main__":
    main()
