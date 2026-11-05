# -*- coding: utf-8 -*-
"""
dateaudit.py —— 同一个年份，在多少张图上被摆到了不同的日子。

为什么要有这个：
audit_prov.py 数的是「哪些数字没标出身」，它回答不了另一个问题：
**同一个数被画了两次，两次不一样。** 那种错单看一张图看不出来，
只有把一堆脚本摆到一起才露。

用法：
    python3 tools/dateaudit.py            # 扫 work/
    python3 tools/dateaudit.py work/rice  # 只看一摊

判法（粗，只用来排序）：
    每条记录是 (年份, 日期, 是否带「≈／约／大致」)。
    同一个年份出现两种以上日期 → 摆出来，看哪张该改。
    带 ≈ 的算「推的」，不带的算「查到的」——但这条不替你下结论，
    因为本鱼以前也把推出来的写成不带 ≈ 的样子。
"""
import ast, glob, os, re, sys
from collections import defaultdict

YEAR = re.compile(r'(?<!\d)(19|20)\d{2}(?!\d)')
DATE = re.compile(r'(\d{1,2})\s*/\s*(\d{1,2})(?!\d)')
EST = ("≈", "约", "大致", "左右", "前后")
# 年份那一格总是单独一个「2024」，而说明文字里的年份夹在句子里。
# 只认独立的那一格，否则同一行里的两个年份会跟日期串行。
YEAR_FIELD = re.compile(r'^\s*(?:19|20)\d{2}\s*$')

# 看起来像日期标签：短，且就是「M/D」或「≈ M/D」
LABEL = re.compile(r'^\s*[≈约~]?\s*\d{1,2}\s*/\s*\d{1,2}\s*$')


def walk_container(node):
    """只收这一个容器自己的字符串字面量，不跨进里面嵌套的元组。

    一行一条记录长这样：（年份，日期标签，说明，出处）。
    要是把整张表一起摊平，年份和日期就会串行——第一版的错就出在这。
    """
    out = []
    for ch in ast.iter_child_nodes(node):
        if isinstance(ch, ast.Constant) and isinstance(ch.value, str):
            out.append(ch.value)
    return out


def records(path):
    src = open(path, encoding="utf-8").read()
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        return None, str(e)

    got = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Tuple, ast.List, ast.Dict)):
            continue
        strs = walk_container(node)
        if not strs:
            continue
        fields = [s.strip() for s in strs if YEAR_FIELD.match(s)]
        if len(fields) != 1:
            continue
        years = [fields[0]]
        labels = [s.strip() for s in strs if LABEL.match(s)]
        if not labels:
            continue
        # 一个容器里只认「年份和日期对得上」的情况：
        # 有几年就给几个标签，多出来的标签不算
        for y, lab in zip(years, labels):
            day = DATE.search(lab)
            if not day:
                continue
            got.append((y, "%d/%d" % (int(day.group(1)), int(day.group(2))),
                        any(e in lab for e in EST), node.lineno, lab))
    # 同一行同样的东西只留一条
    seen, ded = set(), []
    for r in got:
        k = (r[0], r[1], r[2])
        if k in seen:
            continue
        seen.add(k)
        ded.append(r)
    return ded, None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    root = args[0] if args else "work"

    files = sorted(glob.glob(os.path.join(root, "**", "*.py"), recursive=True))
    files = [f for f in files
             if "/_drafts/" not in f
             and os.path.basename(f) not in ("dateaudit.py", "audit_prov.py")]

    by_year = defaultdict(list)
    n_rec = 0
    for f in files:
        got, err = records(f)
        if got is None:
            print("!! %s 解析失败：%s" % (f, err))
            continue
        for y, day, est, ln, lab in got:
            by_year[y].append((f, day, est, ln))
            n_rec += 1

    def dkey(d):
        m, dd = d.split("/")
        return (int(m), int(dd))

    print("%d 个脚本，抽出 %d 条「某年某日」" % (len(files), n_rec))
    print()

    # 只有「同类相撞」才算打架：
    #   两个都写着「查到的」，日子却不一样 → 至少有一个是假的
    #   两个都写着「推的」，日子却不一样 → 后画的没跟着改先画的
    # 「一个查的 + 一个推的」不算冲突，那本来就是两件事
    #   （比如 2024 的 6/19 是「还在插」，6/25 是「推出来的插完日」）
    clash = 0
    for y in sorted(by_year):
        rows = by_year[y]
        for est, tag in ((False, "查到的"), (True, "推的")):
            same = [r for r in rows if r[2] is est]
            days = {r[1] for r in same}
            if len(days) < 2:
                continue
            clash += 1
            print("### %s 的%s —— 同一类，摆出了 %d 个日子：%s"
                  % (y, tag, len(days),
                     " · ".join(sorted(days, key=dkey))))
            print("    （先看是不是同一件事。同一年里「正在插」和「插完了」本来就是两天。）")
            for f, day, _, ln in sorted(same, key=lambda r: dkey(r[1])):
                print("    %-6s %-34s 第 %d 行" % (day, f, ln))
            print()

    # 查的和推的并排出现，不算错，但要让人一眼看见差在哪
    print("--- 以下是查到的和推出来的并排（正常，只作对照）")
    for y in sorted(by_year):
        rows = by_year[y]
        pair = sorted({r[1] for r in rows if not r[2]}, key=dkey)
        calc = sorted({r[1] for r in rows if r[2]}, key=dkey)
        print("  %s   查到：%-22s 推出：%s"
              % (y, " ".join(pair) or "—", " ".join(calc) or "—"))

    print()
    if clash:
        print("同类相撞 %d 处，上面那几组要回去对一遍。" % clash)
    else:
        print("没有同类相撞。")


if __name__ == "__main__":
    main()
