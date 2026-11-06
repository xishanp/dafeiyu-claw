# -*- coding: utf-8 -*-
"""
paper_claims.py —— 只对「纸上真出现的数」问出身，把刻度、分箱、画法规格剔掉。

为什么要有这个：
canvas_capture.py 已经能对账「静态扫到的」和「纸上真有的」，漏的那 65 处
全列出来是没用的——一大半根本不是数，是轴的刻度（2万/4万/6万）、
是分箱标签（30–120 条）、是画法规格（每格 400 × 72 km）。

把这些混进「可疑清单」里，真正那几条就被淹了。这一层只做一件事：
**把一张纸上的字分成「在说世界」和「在说这张图」两类。**

在说这张图（不算数）：
    纯数字或数字+单位，短，且没有谓语   → 刻度、编号、行列号
    带 – — ~ 两个端点                    → 分箱
    含 × ／ 「随机」「铺」「每格」        → 画法规格

在说世界（要出身）：
    其余所有带数字的话。

用法：
    python3 tools/paper_claims.py work/audit/capture.json
    python3 tools/paper_claims.py work/audit/capture.json --world   # 只看说世界的
"""
import json
import re
import sys

TICK = re.compile(r"^[≈~<>]?\s*[\d.,]+\s*(万|年|公里|km|%|具|条|句|行|张|e|亿|公顷|km²|年)?$")
RANGE = re.compile(r"[\d]\s*[–—~-]\s*[\d]")
SPEC = re.compile(r"[×x／]|随机|铺|每格|位置")


def kind(s):
    t = s.strip()
    if not re.search(r"\d", t):
        return "no-number"
    if RANGE.search(t) and len(t) <= 14:
        return "bin"
    if TICK.match(t):
        return "tick"
    if SPEC.search(t) and len(t) <= 30:
        return "spec"
    return "world"


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "work/audit/capture.json"
    only_world = "--world" in sys.argv
    data = json.load(open(path, encoding="utf-8"))

    tally = {"tick": 0, "bin": 0, "spec": 0, "no-number": 0, "world": 0}
    world_rows = []

    for e in data:
        for s in e.get("only_drawn") or []:
            k = kind(s)
            tally[k] += 1
            if k == "world":
                world_rows.append((e["py"], s))

    print("纸上多出来的 %d 处，按它是谁的话分类：" % sum(tally.values()))
    for k, label in (("tick", "轴的刻度"), ("bin", "分箱标签"),
                     ("spec", "画法规格"), ("no-number", "没有数字")):
        if tally[k]:
            print("  %-6s %3d" % (label, tally[k]))
    print("  %-6s %3d  ← 只有这些需要出身" % ("说世界", tally["world"]))
    print()

    if tally["world"]:
        print("在说世界、却没标出身的：")
        for py, s in world_rows:
            print("  %-28s %s" % (py.replace("work/", ""), s[:110]))
    if only_world:
        return


if __name__ == "__main__":
    main()
