import math, random
from PIL import Image, ImageDraw, ImageFilter

W = H = 360
SS = 2
w, h = W*SS, H*SS
N = 44
FPS = 12
BG = (9, 11, 17)

random.seed(7)
# 一圈尘：角度、起始半径系数、大小、亮度
DUST = []
for _ in range(150):
    ang = random.uniform(0, 2*math.pi)
    base = random.uniform(0.95, 1.75)      # 相对光晕外径
    DUST.append((ang, base, random.uniform(0.6, 1.9),
                 random.uniform(0.25, 1.0), random.uniform(0, 2*math.pi)))

def breath_val(i):
    p = 2*math.pi*i/N
    return (math.sin(p - math.pi/2) + 1) / 2

def frame(i):
    ease = breath_val(i) ** 1.35
    r_out = (140 + 30*ease) * SS
    cx, cy = w/2, h/2

    layer = Image.new("RGBA", (w, h), (0,0,0,0))
    rings = 56
    for k in range(rings):
        t = k/(rings-1)
        rr = r_out * (1 - t*0.985)
        a = 0.05 * (0.25 + 0.75*(t**1.8)) * (0.5 + 0.5*ease)
        col = (int(88+128*t), int(165+76*t), int(212+38*t))
        ring = Image.new("RGBA", (w, h), (0,0,0,0))
        ImageDraw.Draw(ring).ellipse([cx-rr, cy-rr, cx+rr, cy+rr], fill=col+(int(255*a),))
        layer = Image.alpha_composite(layer, ring)
    layer = layer.filter(ImageFilter.GaussianBlur(2.2*SS))

    # 尘：吸气时往里收，呼气时散开
    dust = Image.new("RGBA", (w, h), (0,0,0,0))
    dd = ImageDraw.Draw(dust)
    for ang, base, size, bright, phase in DUST:
        # 半径随呼吸收缩：吸气收 22%
        rr = base * r_out * (1.0 - 0.22*ease) * 1.0
        # 一点点缓慢自转，别像齿轮
        a2 = ang + 0.05*math.sin(2*math.pi*i/N + phase)
        x = cx + math.cos(a2)*rr
        y = cy + math.sin(a2)*rr*0.98
        # 只在吸气过程中亮，散开时淡下去
        al = bright * (0.10 + 0.42*ease)
        s = size*SS
        dd.ellipse([x-s, y-s, x+s, y+s],
                   fill=(190, 226, 245, int(255*min(al,1.0))))
    dust = dust.filter(ImageFilter.GaussianBlur(1.1*SS))
    layer = Image.alpha_composite(layer, dust)

    img = Image.alpha_composite(Image.new("RGBA", (w, h), BG+(255,)), layer)

    core_r = (12 + 8*ease) * SS
    cl = Image.new("RGBA", (w, h), (0,0,0,0))
    dc = ImageDraw.Draw(cl)
    dc.ellipse([cx-core_r, cy-core_r, cx+core_r, cy+core_r],
               fill=(234, 248, 255, int(255*(0.60+0.32*ease))))
    cl = cl.filter(ImageFilter.GaussianBlur(2.6*SS))
    img = Image.alpha_composite(img, cl)
    return img.convert("RGB").resize((W,H), Image.LANCZOS)

frames = [frame(i) for i in range(N)]
frames[0].save("toys/breathe.gif", save_all=True, append_images=frames[1:],
               duration=int(1000/FPS), loop=0, optimize=True)
strip = Image.new("RGB", (W*2, H//2))
for j,i in enumerate((0, N//4, N//2, 3*N//4)):
    strip.paste(frames[i].resize((W//2, H//2)), ((j%4)*(W//2), 0))
strip.save("toys/breathe_strip.png")
print("ok")
