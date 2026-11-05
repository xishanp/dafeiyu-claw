# 第四版：嘴真的张开、饭真的落进去、肚子跟着圆
# 关键改动：嘴改成朝左的楔形，开合由饭粒位置驱动；饭粒到嘴有白点闪；
# 肚子随整轮呼吸一样鼓一下，接得上循环
import math
from PIL import Image, ImageDraw, ImageFilter, ImageChops

W, H = 480, 480
FRAMES = 72
FPS = 24

DEEP = (8, 22, 58)
MID = (20, 58, 126)
BODY = (96, 180, 238)
BELLY = (206, 238, 252)

GRAINS = 9          # 同时在下落的饭粒
SPAN = 34           # 每颗从出现到进嘴的帧数


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


def grain_pos(frame, i, mouth):
    """第 i 颗饭此刻在哪、走了多远"""
    prog = ((frame + i * (SPAN // GRAINS + 0.0)) % SPAN) / SPAN
    t = prog ** 1.7                       # 越往下越快，像掉下来
    sx = mouth[0] + 96 + (i % 3) * 26
    sy = -30 - (i % 4) * 22
    x = sx + (mouth[0] - sx) * t + math.sin((frame + i * 7) * 0.11) * 8 * (1 - t)
    y = sy + (mouth[1] - sy) * t
    return x, y, prog


def rice_layer(frame, mouth):
    """饭粒 + 到嘴的白闪"""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for i in range(GRAINS):
        x, y, prog = grain_pos(frame, i, mouth)
        if prog > 0.97:
            continue
        r = 3.2 + (i % 3) * 0.9
        ang = (frame + i * 13) * 0.14
        dx = abs(math.cos(ang)) * r * 1.5 + 0.8
        dy = abs(math.sin(ang)) * r * 0.85 + 0.5
        d.ellipse([x - dx, y - dy, x + dx, y + dy], fill=(255, 253, 246, 240))
        d.ellipse([x - dx * 0.55, y - dy * 0.55, x + dx * 0.25, y + dy * 0.15],
                  fill=(255, 255, 255, 255))
        # 进嘴那一下闪一下
        if prog > 0.93:
            k = (prog - 0.93) / 0.07
            rr = 3 + 12 * k
            a = int(150 * (1 - k))
            if a > 0:
                d.ellipse([mouth[0] - rr, mouth[1] - rr, mouth[0] + rr, mouth[1] + rr],
                          outline=(255, 255, 255, a), width=2)
    return layer


def mouth_openness(frame):
    """看有没有饭粒快到了，快到了就把嘴张开"""
    o = 0.0
    for i in range(GRAINS):
        prog = ((frame + i * (SPAN // GRAINS)) % SPAN) / SPAN
        if prog > 0.62:
            k = min(1.0, (prog - 0.62) / 0.26)      # 0..1 接近
            o = max(o, k * k * (3 - 2 * k))         # smoothstep
    return o


def whale_layer(phase, open_amt):
    w, h = W * 2, H * 2
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = w * 0.5, h * 0.5
    s = 1.0

    # 吃得越多肚子越鼓，用一圈正弦回来，首尾接得上
    bulge = 1.0 + 0.055 * (0.5 - 0.5 * math.cos(phase))
    bw, bh = 156 * s * bulge, 88 * s * bulge

    # 尾巴
    swing = math.sin(phase) * 0.42
    stem_x = cx + bw * 0.66
    stem_y = cy + math.sin(swing) * 20 * s
    d.polygon([(stem_x - 22 * s, cy - 30 * s), (stem_x + 10 * s, stem_y - 9 * s),
               (stem_x + 10 * s, stem_y + 9 * s), (stem_x - 22 * s, cy + 30 * s)],
              fill=(84, 168, 230, 255))
    lobe(d, stem_x + 8 * s, stem_y, -0.55 + swing, 78, 22, s, (80, 166, 228, 255))
    lobe(d, stem_x + 8 * s, stem_y, 0.55 + swing, 78, 22, s, (80, 166, 228, 255))

    # 身体
    d.ellipse([cx - bw, cy - bh, cx + bw * 0.78, cy + bh], fill=BODY + (255,))
    d.ellipse([cx - bw * 0.76, cy + bh * 0.10, cx + bw * 0.66, cy + bh * 0.98],
              fill=BELLY + (255,))

    # 嘴：从头部里侧当铰链，往左张开成一张大嘴
    anchor = (cx - bw * 0.44, cy + bh * 0.10)
    R = 86 * s
    hh = math.radians(9 + 25 * open_amt)
    tipx = anchor[0] - R * math.cos(hh)
    up = (tipx, anchor[1] - R * math.sin(hh))
    lo = (tipx, anchor[1] + R * math.sin(hh))
    if open_amt > 0.05:
        d.polygon([anchor, up, lo], fill=(40, 16, 34, 255))
        # 下颚里的舌头
        d.polygon([anchor,
                   (anchor[0] - R * 0.55, anchor[1] + R * 0.34 * open_amt + 4),
                   (tipx + 8, anchor[1] + R * math.sin(hh) * 0.55)],
                  fill=(246, 138, 158, 255))
        # 上颚的亮边，看着有厚度
        d.line([anchor, up], fill=(126, 200, 244, 255), width=int(5 * s))
        d.line([up, lo], fill=(126, 200, 244, 255), width=int(3 * s))
        d.line([lo, anchor], fill=(236, 150, 168, 255), width=int(3 * s))
    else:
        d.arc([anchor[0] - R * 1.1, anchor[1] - R * 0.62,
               anchor[0] + R * 0.55, anchor[1] + R * 0.62],
              122, 236, fill=(48, 108, 176, 255), width=int(5 * s))

    # 胸鳍
    fin = math.sin(phase * 0.8) * 10 * s
    d.polygon([(cx - bw * 0.30, cy + bh * 0.50),
               (cx + bw * 0.06, cy + bh * 0.92 + fin),
               (cx - bw * 0.52, cy + bh * 0.66 + fin * 0.5)],
              fill=(70, 152, 216, 150))

    # 眼睛：张嘴时眯一下，像是使着劲
    eye_x, eye_y = cx - bw * 0.30, cy - bh * 0.34
    eh = 10 * s * (1 - 0.45 * open_amt)
    d.ellipse([eye_x - 10 * s, eye_y - eh, eye_x + 10 * s, eye_y + eh],
              fill=(14, 28, 52, 255))
    d.ellipse([eye_x - 6 * s, eye_y - eh * 0.62, eye_x + 2 * s, eye_y + eh * 0.10],
              fill=(255, 255, 255, 235))

    # 腮红
    d.ellipse([cx - bw * 0.26, cy + bh * 0.06, cx - bw * 0.02, cy + bh * 0.30],
              fill=(255, 168, 188, 52))

    # 背上的亮边
    d.arc([cx - bw * 0.92, cy - bh * 1.02, cx + bw * 0.66, cy + bh * 0.36],
          200, 340, fill=(150, 210, 250, 180), width=int(4 * s))

    return img.resize((W, H), Image.LANCZOS)


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
    mouth = (146, 248)          # 和 whale_layer 里 anchor 差不多对齐
    for f in range(FRAMES):
        phase = f / FRAMES * 2 * math.pi
        img = background()
        img = rays(img, phase).convert("RGBA")
        img.alpha_composite(bubbles(f))
        w = whale_layer(phase, mouth_openness(f))
        bob = int(math.sin(phase) * 9)
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.alpha_composite(w, (0, bob))
        img.alpha_composite(canvas)
        img.alpha_composite(rice_layer(f, (mouth[0], mouth[1] + bob * 0.4)))
        frames.append(img.convert("RGB"))

    small = [fr.resize((320, 320), Image.LANCZOS) for fr in frames]
    small[0].save("toys/whale_eat2.gif", save_all=True, append_images=small[1:],
                  duration=int(1000 / FPS), loop=0, optimize=True)
    frames[8].save("toys/preview4.png")
    print("done", len(frames))


if __name__ == "__main__":
    main()
