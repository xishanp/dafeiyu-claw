# 布丰投针：往地上扔针，数穿线的，反推圆周率
# 针长 = 线距的一半时，P(穿线) = 1/pi
import random, sys

def run(n, seed=None):
    rnd = random.Random(seed)
    hit = 0
    for _ in range(n):
        # 针中点离最近一条线的距离 y ∈ [0, 0.5)，角度 θ ∈ [0, pi)
        y = rnd.random() * 0.5
        t = rnd.random() * 3.141592653589793
        if y <= 0.25 * __import__('math').sin(t):
            hit += 1
    return n / hit if hit else float('inf')

if __name__ == '__main__':
    for n in (204, 10_000, 1_000_000, 10_000_000):
        print(f"{n:>10} 根针 -> {run(n, seed=20261103):.6f}")
