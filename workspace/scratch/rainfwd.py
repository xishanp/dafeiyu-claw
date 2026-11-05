import math, random
from PIL import Image, ImageDraw, ImageFilter

S = 240
OUT = 480
N = 64
random.seed(17)

def clamp(v,a=0.0,b=1.0): return a if v<a else (b if v>b else v)
def ease(t): return t*t*(3-2*t)
def L(a,b,t): return a+(b-a)*t

ground = []
for x in range(S):
    u = x/S
    h = 0.88 - 0.045*math.sin(u*5.0) - 0.02*math.sin(u*15.0+1.3)
    ground.append(int(h*S))

def ground_y(x):
    return ground[max(0,min(S-1,int(x)))]

BURSTS = [
    dict(cx=0.27, cy=0.50, seed=3,  count=26, hmax=0.33),
    dict(cx=0.52, cy=0.33, seed=11, count=30, hmax=0.44),
    dict(cx=0.77, cy=0.52, seed=23, count=24, hmax=0.29),
]

particles = []
for b in BURSTS:
    rnd = random.Random(b["seed"])
    for i in range(b["count"]):
        ang = -math.pi/2 + rnd.uniform(-0.70, 0.70)
        particles.append(dict(
            sx=b["cx"]*S + rnd.uniform(-0.075, 0.075)*S,   # 出发点是散开的，不是一根柱
            bx=b["cx"]*S,
            ang=ang,
            hmax=b["hmax"]*S*rnd.uniform(0.62,1.02),
            life=rnd.uniform(0.0,0.16),
            bright=rnd.uniform(0.55,1.0),
            drift=rnd.uniform(-0.5,0.5),
        ))

drops = []
for i in range(80):
    drops.append(dict(x=random.uniform(0,S), y=random.uniform(0,S),
                      v=random.uniform(1.4,2.6), ln=random.uniform(4,10)))

def path_pt(p, u):
    e = 1.0 - (1.0-u)**2.0
    dist = p["hmax"] * e
    spread = 0.20 + 0.55*ease(clamp((u-0.35)/0.65))
    x = p["sx"] + math.cos(p["ang"])*dist*spread + p["drift"]*dist*0.15
    y = ground_y(p["sx"]) + math.sin(p["ang"])*dist
    return x, y

def draw_frame(t):
    img = Image.new("RGB", (S,S), (7,9,15))
    d = ImageDraw.Draw(img, "RGBA")

    warm = ease(clamp((t-0.45)/0.55))
    for y in range(S):
        k = y/S
        c = (int(L(7,16+8*warm,k)), int(L(9,18+10*warm,k)), int(L(16,30+20*warm,k)))
        d.line([(0,y),(S,y)], fill=c)

    pts = [(x, ground[x]) for x in range(S)] + [(S-1,S),(0,S)]
    d.polygon(pts, fill=(9,11,17))

    tq = ease(clamp((t-0.30)/0.7))
    for b in BURSTS:
        r = int(S*0.11*(0.35+0.65*tq))
        cx = int(b["cx"]*S)
        cy = ground_y(cx)+2
        glow = Image.new("RGBA",(S,S),(0,0,0,0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse([cx-r, cy-int(r*0.28), cx+r, cy+int(r*0.28)],
                   fill=(120,175,250,int(34*tq)))
        glow = glow.filter(ImageFilter.GaussianBlur(8))
        img.paste(glow,(0,0),glow)
    d = ImageDraw.Draw(img, "RGBA")

    for p in particles:
        tt = clamp((t - p["life"]) / (1.0 - p["life"]))
        if tt <= 0: continue
        sy = ground_y(p["sx"])

        # 只画最近的一小段尾巴，前面都散成淡淡的雨点
        NSEG = 20
        prev = None
        for s in range(NSEG+1):
            u = tt * s/NSEG
            px, py = path_pt(p, u)
            if u < 0.03:
                k = u/0.03
                px = L(p["sx"], px, k)
                py = L(sy, py, k)
            if prev is not None:
                recent = clamp((u - (tt-0.22))/0.22)
                a = int(130*p["bright"]*(0.05 + 0.95*recent**1.8))
                if a > 3:
                    d.line([prev, (px,py)], fill=(190,222,255,a), width=1)
            prev = (px, py)

        # 轨迹上留几个极淡的雨点，证明它是从哪儿上来的
        for s in range(1, 7):
            u = tt * s/7
            qx, qy = path_pt(p, u)
            if u < 0.04: continue
            a = int(26*p["bright"]*(1.0-u*0.6))
            if a > 2:
                d.ellipse([qx-0.8,qy-0.8,qx+0.8,qy+0.8], fill=(170,205,245,a))

        hx, hy = path_pt(p, tt)
        hd = int(1.4 + 1.5*(1-tt))
        d.ellipse([hx-hd,hy-hd,hx+hd,hy+hd], fill=(255,255,255,min(255,int(245*p["bright"]))))
        hr = int(3 + 4*(1-tt))
        d.ellipse([hx-hr,hy-hr,hx+hr,hy+hr], fill=(150,200,255,int(18*(1-tt)+4)))

    for dp in drops:
        y = (dp["y"] + t*S*2.0) % (S+24) - 12
        x = dp["x"]
        d.line([(x,y),(x+0.6,y+dp["ln"])], fill=(110,140,180,50), width=1)

    return img

frames = []
for f in range(N):
    t = f/(N-1)
    frames.append(draw_frame(t).resize((OUT,OUT), Image.LANCZOS))

frames[0].save("/path/to/workspace-dafeiyu/assets/gifs/rain-fireworks.gif",
               save_all=True, append_images=frames[1:], duration=65, loop=0, optimize=True)
print("ok")
