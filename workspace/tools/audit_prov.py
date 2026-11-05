# -*- coding: utf-8 -*-
"""
audit_prov.py —— 把画图脚本里每一个「会出现在图上」的数字捞出来，问一句：它是哪来的。

为什么要有这个：
tools/prov.py 管的是「画的时候怎么区分」。可本鱼常常绕过它——
直接 d.text((x, y), "约 54 处", ...) 往图上一写，什么都没标。
prov.py 拦不住这个，因为那段文字根本不经过 Point。

所以这一层换个方向看：不看你画了什么，看脚本里**写了哪些数**。
把每个带数字的字符串挑出来，按上下文猜它是查的、算的、还是凭空来的，
然后把「凭空来的」排在最前面。本鱼自己回头看，再定。

第二遍扫（11-05 傍晚补的）：
上一版只看字符串字面量，可有一类数根本不在脚本里——它是拼进去的：
    f"{allst:,} 具"        "%.1f 公里" % v        f"6/{dd}"
这种数在代码里只看到一个变量名，字面量里没有数，所以第一遍全漏了。
它们才是最难看出身的：图上一个「10,745 具」看着像查到的，
脚本里写的是 f"{allst:,}"，allst 是哪来的得往上翻三十行。
所以这一遍专门把它们挑出来，排在最后单列一节。

第三遍扫（同一天晚上又补的）：
第二遍能告诉你「这里有个变量」，但告诉不了「变量里是什么」。
刚才真被这个坑了一次：percapita.png 上最显眼的那个总数，
脚本里只是个数值常量，它躺在 rows 那张表里，
既不在任何字符串里，也不在任何 f-string 里——两遍扫描都是零。
写这段时本鱼顺口推断它是「假设的数」——错了。
69,000 + 103,000 + 690,000 正好 862,000，那是三个阶段相加。
一个刚好小得整数的 0.80 被本鱼读成了「八成是拍的」，差点又编一个故事。
一个数没标出身，不等于它就是编的。
所以第三遍扫「像一行数据」的容器：同时有好几个 ≥20 的数，还带字符串。
那个容器里的每一个数都可能被下标取出来送进画布。
这一遍的判法最粗，只用来点名，不下结论。

用法：
    python3 tools/audit_prov.py            # 扫 work/ ，列出来
    python3 tools/audit_prov.py work/rice  # 只看一摊
    python3 tools/audit_prov.py --mine     # 只列没标过出身的

判法（粗，只用来排序，不替你下结论）：
    查到  这行或上下两行里有「据／出处／原文／报／网／学报／通稿／年鉴」这类字
    算出  这行或上下两行里有「算／推／倒推／估／约／≈／平均／摊／乘／÷」
    没标  两样都没有 —— 这种最该看一眼，因为它看着跟查来的一模一样
"""
import ast, glob, io, os, re, sys

# 拼进画布的那几种写法：f-string、% 格式、str.format
def _dyn_kind(node):
    if isinstance(node, ast.JoinedStr):
        return "f-string"
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod):
        return "%%"
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
            and node.func.attr == "format":
        return ".format"
    return None


def _dyn_src(node):
    try:
        return ast.unparse(node)
    except Exception:
        return "<表达式>"


def bare_tables(path):
    """返回 [(行号, 字符串个数, 数值元组)] —— 像一行数据的容器。

    「像一行数据」= 里面至少一个短字符串，而且有两个以上 ≥20 的数。
    这种容器的数几乎一定会被下标取出来送上画布（f"{area:,}"），
    但它们本身不在任何字符串字面量里，前两遍扫不到。
    """
    src = open(path, encoding="utf-8").read()
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return [], None
    out = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Tuple, ast.List)):
            continue
        if len(node.elts) < 3:
            continue
        strs = [e for e in node.elts
                if isinstance(e, ast.Constant) and isinstance(e.value, str)
                and len(e.value) < 40]
        nums = [e.value for e in node.elts
                if isinstance(e, ast.Constant)
                and isinstance(e.value, (int, float))
                and not isinstance(e.value, bool)
                and abs(e.value) >= 20]
        if len(strs) >= 1 and len(nums) >= 2:
            out.add((node.lineno, len(strs), tuple(nums)))
    return sorted(out), None

SRC_WORDS = ("据", "出处", "来源", "原文", "引自", "报", "新闻网", "学报", "期刊",
             "通稿", "年鉴", "统计", "官网", "政府", "采访", "访谈", "论文",
             "发布", "公告", "通报", "资料", "文献", "研究")
CALC_WORDS = ("算", "推", "倒推", "估", "约", "≈", "大概", "平均", "摊", "乘",
              "÷", "反比", "取值", "假设", "按", "折算", "换算", "取整")

SKIP = re.compile(
    r'(^[\d\-/：:．. ]+$)'        # 纯日期、纯数字
    r'|(\.png$)|(\.py$)|(\.jpg$)|(\.gif$)|(\.mp3$)|(\.pdf$)'
    r'|(^/Users/)|(^memory/)|(^work/)'
    r'|(^[A-Za-z0-9_\-]+$)'        # 纯英文串
    # 正则、格式串、路径片段：不是给人看的数
    r'|([\\\[\]{}^$|])'
    r'|(%s$)|(%d$)'
)


def numeric_strings(path):
    """返回 [(行号, 字符串)] —— 脚本里所有含数字的短字符串字面量。"""
    src = open(path, encoding="utf-8").read()
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        return None, str(e)
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            s = node.value.strip()
            if not re.search(r"\d", s):
                continue
            if len(s) < 2 or len(s) > 160:
                continue
            # 要「给人看的一句话」：得有中文，或者像个百分数/量词
            has_cn = re.search(r"[\u4e00-\u9fff]", s)
            if not has_cn:
                continue
            if SKIP.search(s):
                continue
            out.append((node.lineno, s))
    return sorted(set(out)), None


def classify(path, lineno, s, lines):
    ctx = s
    for k in range(max(0, lineno - 3), min(len(lines), lineno + 2)):
        ctx += lines[k]
    if any(w in ctx for w in CALC_WORDS):
        return "算出"
    if any(w in ctx for w in SRC_WORDS):
        return "查到"
    return "没标"


def dynamic_strings(path):
    """返回 [(行号, 写法, 源码)] —— 送进画布但是拼出来的那几处。

    只认 d.text / dr.text / d.textlength 这类画布调用里的第 2 个参数，
    别把别处的 f-string（路径、日志）也算进来。
    """
    src = open(path, encoding="utf-8").read()
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return [], None
    out = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        if node.func.attr not in ("text", "textlength", "textbbox"):
            continue
        if len(node.args) < 2:
            continue
        kind = _dyn_kind(node.args[1])
        if not kind:
            continue
        out.append((node.args[1].lineno, kind, _dyn_src(node.args[1])))
    return sorted(set(out)), None


def scan(root, only_bare=False):
    files = sorted(glob.glob(os.path.join(root, "**", "*.py"), recursive=True))
    files = [f for f in files if "/_drafts/" not in f and os.path.basename(f) not in ("audit_prov.py", "chart2.py")]
    rows = []
    for f in files:
        got, err = numeric_strings(f)
        if got is None:
            rows.append((f, "解析失败", err, []))
            continue
        lines = open(f, encoding="utf-8").read().splitlines()
        tagged = [(classify(f, ln, s, lines), ln, s) for ln, s in got]
        dyn, _ = dynamic_strings(f)
        tabs, _ = bare_tables(f)
        if not tagged and not dyn and not tabs:
            continue
        rows.append((f, None, None, tagged, dyn, tabs))
    return rows


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    only_bare = "--mine" in sys.argv
    root = args[0] if args else "work"
    rows = scan(root)

    tot = {"查到": 0, "算出": 0, "没标": 0}
    dyn_tot = 0
    tab_tot = 0
    for _, err, _, tagged, dyn, tabs in rows:
        for k, _, _ in tagged:
            tot[k] += 1
        dyn_tot += len(dyn)
        tab_tot += len(tabs)

    print(f"扫 {len(rows)} 个画图脚本，图上会出现 {sum(tot.values())} 处带数字的话")
    print("  查到 %d · 算出 %d · 没标 %d" % (tot["查到"], tot["算出"], tot["没标"]))
    print("  另有 %d 处是拼出来的 —— 字面量里一个数都没有，第一遍扫不到" % dyn_tot)
    print("  另有 %d 行数据表里的裸数 —— 连字符串都不是，前两遍都扫不到" % tab_tot)
    print()

    for f, err, msg, tagged, dyn, tabs in rows:
        if err:
            print(f"### {f}  {msg}")
            continue
        bare = [t for t in tagged if t[0] == "没标"]
        if only_bare and not bare:
            continue
        print(f"### {f}   共 {len(tagged)} 处，没标 {len(bare)}"
              + (f"，拼出来 {len(dyn)} 处" if dyn else "")
              + (f"，裸数表 {len(tabs)} 行" if tabs else ""))
        show = bare if only_bare else [t for t in tagged if t[0] != "查到"]
        for k, ln, s in show:
            print(f"   {k}  {ln:>4}  {s[:110]}")
        print()

    # 单列一节：这些数在脚本里只有变量名，看不到值
    print("=" * 70)
    print("拼进画布的（字面量里没数，第一遍扫不到）")
    print("=" * 70)
    print()
    if not dyn_tot:
        print("  一处都没有。")
    for f, err, msg, tagged, dyn, tabs in rows:
        if err or not dyn:
            continue
        print(f"### {f}   拼出来 {len(dyn)} 处")
        for ln, kind, s in dyn:
            print(f"   {kind:<9} {ln:>4}  {s[:120]}")
        print()

    # 再单列一节：这些数在数据表里躺着，连变量名都没露在画布调用上
    print("=" * 70)
    print("数据表里的裸数（看着像一行数据，前两遍都扫不到）")
    print("=" * 70)
    print()
    if not tab_tot:
        print("  一处都没有。")
    for f, err, msg, tagged, dyn, tabs in rows:
        if err or not tabs:
            continue
        print(f"### {f}   裸数表 {len(tabs)} 行")
        for ln, ns, nums in tabs:
            print(f"          {ln:>4}  {ns} 个串 + 数 {list(nums)[:6]}")
        print()


if __name__ == "__main__":
    main()
