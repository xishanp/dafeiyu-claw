# -*- coding: utf-8 -*-
"""
holdout_verdict.py —— 留出集那批，逐条自己判一次，给工具算分。

这一步不能由 claims_of 自己干：它的判法就是被评的东西。
所以这里是**手判**，一条一条写我为什么这么判。
判完才能回答那个问题：claims_of 在没见过的脚本上，还准不准。

只在最粗的粒度上判：这条句子是在说海底/米/那片地，还是在数我自己的东西。

用法：
    python3 tools/holdout_verdict.py
    python3 tools/holdout_verdict.py --json work/audit/verdict.json
"""
import json
import os
import re
import sys

ROOT = os.path.expanduser("~/.openclaw/workspace")
sys.path.insert(0, os.path.join(ROOT, "tools"))

# 手判：工具判成 world 的每一条，到底是 1=在说世界 还是 0=在说我自己的东西。
# 键是句子（去空格）。判错了随时改这里，分数跟着变。
HAND = {
    "日记751·自己写的55·关于自己87·人16": (0, "数我自己的日记"),
    "751条日记·55条自己写的·87条关于自己·16个人": (0, "同一句，8 个草稿各一份"),
    "之前说「751条日记」，是连日志行一起数进去的。真按话算，只有217条。": (0, "论我这套数法"),
    "306行那天最吓人，可它一条自己的话都没有。": (0, "数我自己的日记行"),
    "11.0s": (0, "耗时轴刻度"),
    "0.55s": (0, "耗时轴刻度"),
    "同一个序列，方向反了，快20倍": (0, "比我自己的两版脚本"),
    "最近邻平均12km": (1, "海底：岛与岛的间距"),
    "≈0处": (1, "一格里有几处"),
    "约21处": (1, "同上"),
    "最近邻平均5km": (1, "捕鲸前那片海底"),
    "约184处": (1, "同上"),
    "每一格宽200km；同一时刻海床上正在腐烂的鲸尸，估计约69万具": (1, "全世界的鲸尸数"),
    "约57处": (1, "一格里的鲸落数"),
    "按最近邻5km，一格约328处。六倍": (1, "同上，换一个间距"),
    "约328处": (1, "同上"),
    "约58处": (1, "同上的第三版"),
    "约341处": (1, "同上"),
    "约54处": (1, "第四版，最后上纸的那个数"),
    "约268处": (1, "同上"),
    "跑出来数到的，去重后325句": (0, "数我自己的审计结果"),
    "65处。全是循环里画出来的——表里一个值，走一趟变一句。": (0, "数我自己的漏报"),
    "862,000具/10,745具/179具": (1, "三个真实具数，并列摆着但说的是海底"),
    "records2.py": (0, "脚本名"),
    "islands6.py": (0, "脚本名"),
    "这片2.9万km²里约54处": (1, "要出身的就这一句"),
    "percapita2.py": (0, "脚本名"),
    "120–400条/30–120条/400条以上": (0, "分箱标签"),
    "前10重合": (0, "图例"),
    "chart2": (0, "脚本名"),
    "records2": (0, "脚本名（无扩展名那处）"),
    "islands6": (0, "脚本名（无扩展名那处）"),
    "「这片2.9万km²里约54处」": (0, "引述上一层结论，不是新主张"),
    "percap2": (0, "脚本名"),
    "lamp2": (0, "脚本名"),
    "去掉「2万」「30–120条」这种": (0, "讲我这套筛法"),
    "只剩「这片2.9万km²里约54处」": (0, "讲我这套筛法"),
    "34条摊开之后": (0, "数我自己的中间结果"),
    "「其中硫化物阶段690,000」——出身跟着那一行走": (0, "讲我自己的注脚规则"),
    "可是这个「1」不能信": (0, "讲我自己的结论"),
    "看有没有带着实地名词被压掉的。15条，逐条看过，都是图例、注脚、或标了页码的。": (0, "数我自己的分类"),
    "①全按一个底（418.8km²/具）": (0, "讲这张图怎么算的"),
    "图上写的是：10745具·其中硫化物阶段8654": (1, "海底具数"),
    "图上写的是：179具·其中硫化物阶段144": (1, "同上"),
    "在这行和上一行之间：862,000和10,745用的是418.8，8,654用的是520。": (0, "讲我这两个底"),
    "上一版抓的是「520和862,000摆在一起」。这张抓的是同一件事的第二步：": (0, "讲我上一张图"),
    "520是只除690,000的，418.8是除862,000的。一行里只能有一个底，混着用，": (0, "讲我这两个底"),
}


def key(s):
    t = re.sub(r"\s+", "", s)
    t = t.replace("条日记", "日记").replace("（", "(").replace("）", ")")
    return t


def main():
    import claims_of as C
    import paper_claims as P

    rows = json.load(open(os.path.join(ROOT, "work/audit/holdout.json"), encoding="utf-8"))

    flagged = []
    for r in rows:
        for s in r["world"]:
            if C.who(s) == "world":
                flagged.append((os.path.basename(r["py"]), s))

    uniq = {}
    for py, s in flagged:
        uniq.setdefault(key(s), []).append((py, s))

    unknown = [k for k in uniq if k not in {key(x) for x in HAND}]
    H = {key(k): v for k, v in HAND.items()}
    tp = sum(H[k][0] for k in uniq if k in H)
    fp = sum(1 - H[k][0] for k in uniq if k in H)

    print("留出集 50 个脚本，纸上 %d 句带数，其中第二层判成「说世界」%d 句，"
          % (sum(len(r["numbered"]) for r in rows), sum(len(r["world"]) for r in rows)))
    print("第四层再判成 world 的 %d 句（去重后 %d 种说法）。\n" % (len(flagged), len(uniq)))
    if unknown:
        print("!! 手判表里没有的：%d 种" % len(unknown))
        for k in unknown[:8]:
            print("   ", k[:70])
        print()

    print("手判结果：")
    print("  真的在说世界      %2d" % tp)
    print("  其实在数我自己    %2d" % fp)
    print("  准头              %2.0f%%" % (100.0 * tp / max(tp + fp, 1)))

    print("\n判错的这些，长什么样：")
    seen_cat = {}
    for k in uniq:
        if k not in H:
            continue
        truth, why = H[k]
        if truth:
            continue
        seen_cat.setdefault(why.split("，")[0], []).append(k)
    for why, ks in sorted(seen_cat.items(), key=lambda x: -len(x[1])):
        print("  ×%-3d %-16s 例：%s" % (len(ks), why, ks[0][:46]))

    # 反向：被挡成 self/cited/label 的，有没有真的漏了世界
    maybe = []
    for r in rows:
        for s in r["numbered"]:
            if P.kind(s) != "world":
                continue
            w = C.who(s)
            if w != "world" and any(t in s for t in ("鲸", "具", "km", "稻", "亩", "公顷")):
                maybe.append((os.path.basename(r["py"]), w, s))
    print("\n反向：被挡成「在说我自己/有出处/注脚」、但句子里有实地名词的 %d 条" % len(maybe))
    for n, w, s in maybe[:10]:
        print("  [%-5s] %-16s %s" % (w, n, s[:64]))

    if "--json" in sys.argv:
        p = sys.argv[sys.argv.index("--json") + 1]
        json.dump({"flagged": len(flagged), "unique": len(uniq), "tp": tp, "fp": fp,
                   "cats": {w: len(v) for w, v in seen_cat.items()},
                   "maybe_missed": len(maybe)},
                  open(os.path.join(ROOT, p), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        print("\n写进 %s" % p)


if __name__ == "__main__":
    main()
