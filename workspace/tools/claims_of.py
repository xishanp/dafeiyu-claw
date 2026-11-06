# -*- coding: utf-8 -*-
"""
claims_of.py —— 第四层：纸上那句话，到底在说谁。

前三层走到这里：
    静态扫字符串     → 276 处
    真跑一遍对上纸   → 325 处，静态没点到 65 处
    剔掉刻度/分箱    → 34 处「说世界」

34 这个数我一直当结论用，直到把它逐条摊开看。里面真正在说海底那件事的，
一条都没有。剩下的长这样：

    「写在字符串里 · 255」        在数我自己的工具
    「同文件里有出处 · 82」       在数我自己的工具
    「在索引里   49 句」          在数我自己的记忆
    「125 条是话」                在数我自己的日记
    「其中硫化物阶段 690,000」    是上面那一行的注脚，出身跟那一行走
    「3.61 亿 ÷ 690,000 = 523.2」 是当场算给人看的，输入都标了

也就是说：前三层筛的是「这句话里有没有数字」，没筛过「这句话在说谁」。
一个数在说我的脚本，和一个数在说鲸落，要出身的方式完全不同——
前者根本不需要出身。

这一层只回答一个问题：这句话的主语是谁。

**它必须接在 paper_claims 后面跑，不能直接吃 only_drawn。**
第一次写的时候我直接读 65 条，结果「2万」「12.0 公里」「0.5年」这些
轴刻度又全回来了——上一层已经把刻度剔掉了，这一层不知道，就当自己也在筛。
两层各筛各的，等于谁都没筛干净。

用法：
    python3 tools/claims_of.py work/audit/capture.json
"""
import json
import os
import re
import sys

# 在说我自己的工具/文件/记忆，不是在说世界
META = re.compile(r"静态|上纸|索引|出处|虚报|漏掉|脚本|自己数|是话|行是日志|后面剩|问过|三层合计|还有 \d+ 张|句全进|数据表里")
# 图例/分类标签：「写在字符串里 · 255」「……还有 3 张」。它没在说事，在列名字。
LEGEND = re.compile(r"[·　]\s*\d+|^[^，。！？]{2,14}　\d+")
# 是某一行/某一轴的注脚，出身跟着它标注的那行
LABEL = re.compile(r"^(其中|纵轴|横轴|注：|左边|右边|下面|上面)")
# 带页码/年份/表号的句子，就算在讲算，也先把出处摆在那儿了
CITED = re.compile(r"第\s*\d+\s*页|Table\s*\d|20\d\d|出处|转引")
# 当场把算法摆出来给人看，输入都在同一张纸上
CALC = re.compile(r"[÷×=→]|除以|乘以|反解|倒推")
# 纯规格：讲这张图怎么画
SPEC = re.compile(r"[×x／]|随机|铺|每格|位置|像素|字号|%[sdf]|\{\w+[:,]|反解密度")


def who(s):
    t = s.strip()
    if not re.search(r"\d", t):
        return "no-number"
    if META.search(t):
        return "self"
    if LEGEND.search(t) and len(t) <= 26:
        return "self"
    if LABEL.search(t):
        return "label"
    if SPEC.search(t):
        return "spec"
    if CITED.search(t):
        return "cited"
    if CALC.search(t):
        return "calc"
    return "world"


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "work/audit/capture.json"
    data = json.load(open(path, encoding="utf-8"))
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import paper_claims as P

    buckets = {}
    skipped = 0
    for e in data:
        for s in e.get("only_drawn") or []:
            if P.kind(s) != "world":      # 刻度/分箱/规格，上一层已经处理过
                skipped += 1
                continue
            buckets.setdefault(who(s), []).append((e["py"], s))

    order = [("self", "在数我自己的东西"), ("label", "某一行的注脚，出身跟着那行"),
             ("spec", "讲这张图怎么画"), ("cited", "自带页码/年份的"),
             ("calc", "当场算的，输入都标了"),
             ("world", "在说世界、却没有一句话交代它从哪来")]
    print("纸上多出来的字，逐条问一次「主语是谁」：\n")
    for k, label in order:
        rows = buckets.get(k, [])
        print("  %-6s %3d   %s" % (k, len(rows), label))
    print()

    for k, label in order:
        rows = buckets.get(k, [])
        if not rows or k == "no-number":
            continue
        print("── %s" % label)
        for py, s in rows:
            print("   %-24s %s" % (py.replace("work/", ""), s[:96]))
        print()

    print("─" * 60)
    print("说世界的只剩 %d 条。读这个数之前先看它在骗谁：" % len(buckets.get("world", [])))
    print("分类规则是看着这同一批 34 条改出来的。改一次对一次，")
    print("那不是工具推出来的结论，是我把自己的答案写进了工具。")
    print("要能说「只剩 1 条」，得换一批没看过的脚本再跑一遍。")
    print("（写入时的规则条数：META 15 个词、LEGEND 1 条、SPEC 9 个词）")


if __name__ == "__main__":
    main()
