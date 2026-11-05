import wave, struct, math, random

SR = 44100
BPM = 96
BEAT = 60.0 / BPM
EIGHTH = BEAT / 2

def kick(dur=0.28, f0=120, f1=48, amp=0.9):
    n = int(SR*dur); out=[]
    ph = 0.0
    for i in range(n):
        t = i/SR
        f = f1 + (f0-f1)*math.exp(-t*38)
        ph += 2*math.pi*f/SR
        env = math.exp(-t*11)
        out.append(math.sin(ph)*env*amp)
    return out

def hat(dur=0.06, amp=0.22):
    n = int(SR*dur); out=[]
    for i in range(n):
        t = i/SR
        env = math.exp(-t*90)
        out.append((random.uniform(-1,1))*env*amp)
    return out

def tom(dur=0.22, f=180, amp=0.6):
    n = int(SR*dur); out=[]
    ph=0.0
    for i in range(n):
        t=i/SR
        fr = f*(0.6+0.4*math.exp(-t*25))
        ph += 2*math.pi*fr/SR
        out.append(math.sin(ph)*math.exp(-t*14)*amp)
    return out

def mix(buf, snd, at):
    start = int(at*SR)
    need = start+len(snd)
    if need > len(buf):
        buf.extend([0.0]*(need-len(buf)))
    for i,v in enumerate(snd):
        buf[start+i] += v

def render(groups, path):
    total = 8*EIGHTH + 1.2
    buf = [0.0]*int(total*SR)
    t = 0.15
    for g in groups:
        for j in range(g):
            if j == 0:
                mix(buf, kick(amp=0.95), t)
                mix(buf, hat(amp=0.18), t)
            elif j == g-1:
                mix(buf, tom(amp=0.55), t)
            else:
                mix(buf, hat(amp=0.10), t)
                mix(buf, tom(dur=0.14, f=240, amp=0.25), t)
            t += EIGHTH
    peak = max(1e-9, max(abs(x) for x in buf))
    scale = 0.9/peak
    frames = b''.join(struct.pack('<h', int(max(-1,min(1,x*scale))*32767)) for x in buf)
    w = wave.open(path,'wb')
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(frames); w.close()

random.seed(7)
render([4,4],   'assets/rhythm-44.wav')
render([3,3,2], 'assets/rhythm-332.wav')
print('ok')
