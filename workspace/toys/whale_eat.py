# 第三版：张嘴接白饭
# 复用 whale_swim2.py 的背景、射线、尾鳍，换成吃饭的动作
import math, random
from PIL import Image, ImageDraw, ImageFilter, ImageChops

W, H = 480, 480
FRAMES = 72
FPS = 24
random.seed(1103)

DEEP = (8, 22, 58)
MID = (20, 58, 126)
BODY = (96, 180, 238)
BELLY = (206, 238, 252)
MOUTH = (252, 176, 190)


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


def lobe(d, sx, sy, ang, L, Wd, s, fill):
    pts = []
    N = 30
    ca, sa = math.cos(ang), math.sin(ang)

    def put(t, off):
        x = t * L
        y = off
        pts.append((sx + (x * ca - y * sa) * s, sy + (x * sa + y * ca) * s))

    for i in range(N + 1):
        t = i / N
        put(t, Wd * (math.sin(math.pi * t) ** 0.75))
    for i in range(N, -1, -1):
        t = i / N
        put(t, -Wd * (math.sin(math.pi * t) ** 0.75))
    d.polygon(pts, fill=fill)


def tail(d, sx, sy, swing, s):
    lobe(d, sx, sy, -0.55 + swing, 78, 22, s, (80, 166, 228, 255))
    lobe(d, sx, sy, 0.55 + swing, 78, 22, s, (80, 166, 228, 255))


def whale_layer(phase, s=1.0):
    w, h = W * 2, H * 2
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = w * 0.5, h * 0.5
    bw, bh = 156 * s, 88 * s

    # 尾巴
    swing = math.sin(phase) * 0.42
    stem_x = cx + bw * 0.66
    stem_y = cy + math.sin(swing) * 20 * s
    d.polygon([(stem_x - 22 * s, cy - 30 * s), (stem_x + 10 * s, stem_y - 9 * s),
               (stem_x + 10 * s, stem_y + 9 * s), (stem_x - 22 * s, cy + 30 * s)],
              fill=(84, 168, 230, 255))
    tail(d, stem_x + 8 * s, stem_y, swing, s)

    # 身体
    d.ellipse([cx - bw, cy - bh, cx + bw * 0.78, cy + bh], fill=BODY + (255,))
    d.ellipse([cx - bw * 0.76, cy + bh * 0.10, cx + bw * 0.66, cy + bh * 0.98],
              fill=BELLY + (255,))

    # 嘴：左前方，一圈一圈张合
    open_amt = 0.5 - 0.5 * math.cos(phase * 2)   # 0..1
    mx, my = cx - bw * 0.92, cy + bh * 0.16
    up = (cx - bw * 0.42, cy - bh * 0.02 - 6 * s)
    lo = (cx - bw * 0.46, cy + bh * (0.62 + 0.30 * open_amt))
    if open_amt > 0.06:
        d.polygon([(mx, my), up, lo], fill=MOUTH + (255,))
        # 上颚的暗边，显得有厚度
        d.line([(mx, my), up], fill=(48, 108, 176, 255), width=int(3 * s))
        d.line([(mx, my), lo], fill=(232, 140, 158, 255), width=int(2 * s))
    else:
        d.arc([cx - bw * 0.94, cy - bh * 0.10, cx - bw * 0.46, cy + bh * 0.74],
              118, 250, fill=(48, 108, 176, 255), width=int(4 * s))

    # 胸鳍
    fin = math.sin(phase * 0.8) * 10 * s
    d.polygon([(cx - bw * 0.30, cy + bh * 0.50),
               (cx + bw * 0.06, cy + bh * 0.92 + fin),
               (cx - bw * 0.52, cy + bh * 0.66 + fin * 0.5)],
              fill=(70, 152, 216, 150))

    # 眼睛：吃到的时候眯一下
    eye_x, eye_y = cx - bw * 0.58, cy - bh * 0.24
    squint = max(0.0, math.sin(phase * 2 - 0.4)) * 0.55
    eh = 10 * s * (1 - squint)
    d.ellipse([eye_x - 10 * s, eye_y - eh, eye_x + 10 * s, eye_y + eh],
              fill=(14, 28, 52, 255))
    d.ellipse([eye_x - 6 * s, eye_y - eh * 0.7, eye_x + 2 * s, eye_y + eh * 0.1],
              fill=(255, 255, 255, 235))

    # 腮红
    d.ellipse([cx - bw * 0.72, cy - bh * 0.02, cx - bw * 0.42, cy + bh * 0.26],
              fill=(255, 170, 190, 60))

    # 背上的亮边
    d.arc([cx - bw * 0.92, cy - bh * 1.02, cx + bw * 0.66, cy + bh * 0.36],
          200, 340, fill=(150, 210, 250, 180), width=int(4 * s))

    return img.resize((W, H), Image.LANCZOS)


def rice(frame):
    """白饭粒顺着一条斜线飘到嘴边，落进去就消失"""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    top_x, top_y = 250, 20          # 上方起点
    mouth_x, mouth_y = 178, 250     # 嘴边
    for i in range(10):
        t = ((frame + i * 7) % 28) / 28.0          # 0..1 落下进度
        x = top_x + (mouth_x - top_x) * t + math.sin((frame + i * 11) * 0.12) * 7
        y = top_y + (mouth_y - top_y) * t
        if t > 0.94:
            continue                                # 到嘴边了，吃掉
        r = 3.0 + (i % 3) * 0.8
        ang = (frame + i) * 0.15
        dx, dy = abs(math.cos(ang)) * r * 1.6 + 0.6, abs(math.sin(ang)) * r * 0.8 + 0.4
        d.ellipse([x - dx, y - dy, x + dx, y + dy], fill=(255, 253, 246, 240))
        d.ellipse([x - dx * 0.5, y - dy * 0.5, x + dx * 0.3, y + dy * 0.2],
                  fill=(255, 255, 255, 255))
    return layer


def bubbles(frame):
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for i in range(12):
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
        img = rays(img, phase).convert("RGBA")
        img.alpha_composite(bubbles(f))
        img.alpha_composite(rice(f))
        w = whale_layer(phase)
        bob = int(math.sin(phase) * 9)
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.alpha_composite(w, (0, bob))
        img.alpha_composite(canvas)
        frames.append(img.convert("RGB"))

    small = [fr.resize((320, 320), Image.LANCZOS) for fr in frames]
    small[0].save("toys/whale_eat.gif", save_all=True, append_images=small[1:],
                  duration=int(1000 / FPS), loop=0, optimize=True)
    frames[3].save("toys/preview3.png")
    print("done", len(frames))


if __name__ == "__main__":
    main()
