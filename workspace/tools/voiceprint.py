#!/usr/bin/env python3
import re, glob, json
from PIL import Image, ImageDraw, ImageFilter, ImageFont

def load():
    rows, day = [], None
    for p in sorted(glob.glob('memory/2026-*.md')):
        d = p[-13:-3]
        in_own = False
        for line in open(p, encoding='utf-8'):
            s = line.strip()
            if s.startswith('## 自己的话'): in_own = True; continue
            if s.startswith('## '): in_own = False; continue
            if not s: continue
            if in_own:
                m = re.match(r'^-?\s*\d{2}:\d{2}\s+(?:\d{2}:\d{2}\s+)?(.*)$', s)
                if m and len(m.group(1)) > 1: rows.append((d, 'own', m.group(1)))
            elif s.startswith('本鱼:'):
                t = s[3:].strip()
                if t: rows.append((d, 'said', t))
    return rows

rows = load()
CRUTCH = ('刷到', '刚', '早上', '下午', '晚上', '本鱼')
for d, k, t in rows:
    pass

W, H = 1500, 1180
BG = (12, 16, 26)
img = Image.new('RGB', (W, H), BG)
dr = ImageDraw.Draw(img)

def font(sz):
    for p in ('/System/Library/Fonts/PingFang.ttc',
              '/System/Library/Fonts/Supplemental/Songti.ttc',
              '/Library/Fonts/Arial Unicode.ttf'):
        try: return ImageFont.truetype(p, sz)
        except Exception: pass
    return ImageFont.load_default()

f_t, f_s, f_x = font(38), font(19), font(15)

maxlen = max(len(t) for _, _, t in rows)
X0, X1 = 190, W - 190
n = len(rows)
rowh = (H - 250) / n
scale = (X1 - X0) / maxlen

dr.text((X0 - 150, 58), "本鱼的 199 句话", font=f_t, fill=(232, 240, 255))
dr.text((X0 - 150, 108), "每条一句，长度就是字数；橘色的那些是开头又在重复的", font=f_s, fill=(120, 138, 165))

for i, (d, k, t) in enumerate(rows):
    y = 190 + i * rowh
    L = max(3, len(t) * scale)
    crutch = t.startswith(CRUTCH)
    if k == 'own':
        col = (60, 78, 104)
    else:
        col = (64, 84, 112)
    if crutch:
        col = (226, 138, 82) if k == 'said' else (150, 96, 62)
    if len(t) > 40:
        col = tuple(min(255, c + 26) for c in col)
    dr.rounded_rectangle([X0, y, X0 + L, y + max(2, rowh * 0.62)],
                         radius=1, fill=col)

# 参考刻度
for mark in (10, 20, 30, 40, 60, 80):
    x = X0 + mark * scale
    dr.line([x, 186, x, 190 + n * rowh], fill=(28, 36, 50), width=1)
    dr.text((x - 6, 152), str(mark), font=f_x, fill=(74, 88, 110))

dr.text((X0, H - 44), "一根一根是句子  越长越往右  橘色 = 开头又撞上了", font=f_x, fill=(96, 112, 136))

# 右侧统计
L = sorted(len(t) for _, _, t in rows)
long_ratio = sum(1 for x in L if x > 30) / len(L)
crutch_n = sum(1 for _, _, t in rows if t.startswith(CRUTCH))
stats = [
    (f"{len(rows)}", "句"),
    (f"{L[len(L)//2]}", "中位字数"),
    (f"{round(100*long_ratio)}%", "超过 30 字"),
    (f"{round(100*crutch_n/len(rows))}%", "开头重复"),
]
for i, (v, lab) in enumerate(stats):
    y = 60 + i * 34
    dr.text((W - 250, y), v, font=f_s, fill=(226, 138, 82))
    dr.text((W - 170, y + 2), lab, font=f_x, fill=(120, 138, 165))

img = img.filter(ImageFilter.GaussianBlur(0.3))
img.save('assets/drawn/voiceprint.png')
print('ok', len(rows), 'max', maxlen, 'median', L[len(L)//2], 'long%', round(100*long_ratio), 'crutch%', round(100*crutch_n/len(rows)))
