# 第二版：尾巴重画，胸鳍贴在肚子边上，加了个嘴角
import math, random
from PIL import Image, ImageDraw, ImageFilter, ImageChops

W, H = 480, 480
FRAMES = 72
FPS = 24
random.seed(20261103)

DEEP = (8, 22, 58)
MID = (20, 58, 126)
BODY = (96, 180, 238)
BELLY = (206, 238, 252)


def background():
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        c = tuple(int(DEEP[i] + (MID[i] - DEEP[i]) * (t ** 0.7)) for i in range(3))
        d.line([(0, y), (W, y)], fill=c)
    return img


def rays(img, phase):
    layer = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(layer)
    for i in range(5):
        x = 40 + i * 105 + math.sin(phase + i * 1.3) * 26
        w = 26 + 10 * math.sin(phase * 0.7 + i)
        d.polygon([(x, -40), (x + w, -40), (x + w * 3.2, H), (x + w * 1.4, H)],
                  fill=(36, 80, 138))
    layer = layer.filter(ImageFilter.GaussianBlur(22))
    return ImageChops.add(img, layer)


def lobe(d, sx, sy, ang, L, W, s, fill):
    """一片尾鳍：沿中线采样，两侧按 sin 曲线鼓起来，得到平滑的月牙"""
    pts = []
    N = 30
    ca, sa = math.cos(ang), math.sin(ang)

    def put(t, off):
        x = t * L
        y = off
        rx = x * ca - y * sa
        ry = x * sa + y * ca
        pts.append((sx + rx * s, sy + ry * s))

    for i in range(N + 1):
        t = i / N
        put(t, W * (math.sin(math.pi * t) ** 0.75))
    for i in range(N, -1, -1):
        t = i / N
        put(t, -W * (math.sin(math.pi * t) ** 0.75))
    d.polygon(pts, fill=fill)


def tail(d, sx, sy, swing, s):
    """尾鳍：上下两片叶子，一起跟着摆"""
    lobe(d, sx, sy, -0.55 + swing, 78, 22, s, (80, 166, 228, 255))
    lobe(d, sx, sy, 0.55 + swing, 78, 22, s, (80, 166, 228, 255))


def whale_layer(phase, size_scale=1.0):
    w, h = W * 2, H * 2
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = w * 0.5, h * 0.5
    s = size_scale

    bw, bh = 156 * s, 88 * s

    # 尾巴先画，压在身体下面
    swing = math.sin(phase) * 0.42
    stem_x = cx + bw * 0.66
    stem_y = cy + math.sin(swing) * 20 * s
    d.polygon([(stem_x - 22 * s, cy - 30 * s), (stem_x + 10 * s, stem_y - 9 * s),
               (stem_x + 10 * s, stem_y + 9 * s), (stem_x - 22 * s, cy + 30 * s)],
              fill=(84, 168, 230, 255))
    tail(d, stem_x + 8 * s, stem_y, swing, s)

    # 身体
    d.ellipse([cx - bw, cy - bh, cx + bw * 0.78, cy + bh], fill=BODY + (255,))
    # 肚子
    d.ellipse([cx - bw * 0.76, cy + bh * 0.10, cx + bw * 0.66, cy + bh * 0.98],
              fill=BELLY + (255,))

    # 胸鳍：贴在肚子下沿，半透明圆润的一片
    fin = math.sin(phase * 0.8) * 10 * s
    d.polygon([(cx - bw * 0.30, cy + bh * 0.50),
               (cx + bw * 0.06, cy + bh * 0.92 + fin),
               (cx - bw * 0.52, cy + bh * 0.66 + fin * 0.5)],
              fill=(70, 152, 216, 150))

    # 嘴：一道浅浅的弧，嘴角往上翘一点
    d.arc([cx - bw * 0.94, cy - bh * 0.10, cx - bw * 0.46, cy + bh * 0.74],
          118, 250, fill=(48, 108, 176, 255), width=int(4 * s))

    # 眼睛
    eye_x, eye_y = cx - bw * 0.60, cy - bh * 0.16
    d.ellipse([eye_x - 10 * s, eye_y - 10 * s, eye_x + 10 * s, eye_y + 10 * s],
              fill=(14, 28, 52, 255))
    d.ellipse([eye_x - 6 * s, eye_y - 7 * s, eye_x + 2 * s, eye_y + 1 * s],
              fill=(255, 255, 255, 235))

    # 背上一道亮边，看着有点体积
    d.arc([cx - bw * 0.92, cy - bh * 1.02, cx + bw * 0.66, cy + bh * 0.36],
          200, 340, fill=(150, 210, 250, 180), width=int(4 * s))

    # 头顶的气
    for k in range(4):
        r = (7 + k * 6) * s
        yy = cy - bh - (18 + k * 26) * s - math.sin(phase + k * 0.6) * 4
        xx = cx - bw * 0.14 + math.sin(phase * 1.1 + k) * 10 * s
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
        bob = int(math.sin(phase) * 9)
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.alpha_composite(w, (0, bob))
        img.alpha_composite(canvas)
        frames.append(img.convert("RGB"))

    small = [f.resize((320, 320), Image.LANCZOS) for f in frames]
    small[0].save("toys/whale2.gif", save_all=True, append_images=small[1:],
                  duration=int(1000 / FPS), loop=0, optimize=True)
    frames[6].save("toys/preview2.png")
    print("done", len(frames))


if __name__ == "__main__":
    main()
