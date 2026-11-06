# -*- coding: utf-8 -*-
"""
canvas_capture.py —— 不猜，跑一遍：把脚本真正画到纸上的每一句话截下来。

为什么要有这个：
audit_prov.py 是静态的，它看的是「脚本里写了哪些带数字的字符串」。
可脚本里写了什么，不等于纸上出现了什么——
    · 有字符串是注释、docstring、日志，根本不上纸
    · 有数在数据表里，靠循环一句一句画，静态只看见一个变量名
它自己最后一节写着：「工具能查出来的只有两个数不一样，
它们本来是不是一件事，工具查不出来。」
这句对，但它上面还有一层更粗的错：**连「上没上纸」它都只能猜。**

所以这一层换个办法：把 ImageDraw.text 拦下来，真跑一遍。
纸上出现过什么，就是什么。

用法：
    python3 tools/canvas_capture.py work/rice/provenance.py
    python3 tools/canvas_capture.py work            # 扫一摊，逐个数
"""
import json, os, re, runpy, sys, io, contextlib, traceback
from PIL import ImageDraw

ROOT = os.path.expanduser("~/.openclaw/workspace")


def capture(path, timeout_note=None):
    """跑一个脚本，返回它画到纸上的句子（去重、保序）。"""
    seen = []
    orig = ImageDraw.ImageDraw.text
    orig_ml = ImageDraw.ImageDraw.multiline_text

    def text(self, xy, s, *a, **k):
        if isinstance(s, str):
            seen.append(s.strip())
        return orig(self, xy, s, *a, **k)

    def mtext(self, xy, s, *a, **k):
        if isinstance(s, str):
            seen.append(s.strip())
        return orig_ml(self, xy, s, *a, **k)

    ImageDraw.ImageDraw.text = text
    ImageDraw.ImageDraw.multiline_text = mtext
    cwd = os.getcwd()
    os.chdir(ROOT)
    err = None
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(os.path.abspath(path), run_name="__main__")
    except SystemExit:
        pass
    except Exception as e:
        err = "%s: %s" % (type(e).__name__, e)
    finally:
        ImageDraw.ImageDraw.text = orig
        ImageDraw.ImageDraw.multiline_text = orig_ml
        os.chdir(cwd)
    return list(dict.fromkeys(seen)), err


def is_numbered(s):
    return bool(re.search(r"\d", s)) and bool(re.search(r"[\u4e00-\u9fff]", s))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    tgt = args[0] if args else "work"
    if tgt.endswith(".py"):
        files = [tgt]
    else:
        import glob
        files = [f for f in sorted(glob.glob(os.path.join(tgt, "**", "*.py"), recursive=True))
                 if "/_drafts/" not in f and os.path.basename(f) not in ("audit_prov.py", "canvas_capture.py")]

    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import audit_prov as A

    rows = []
    for f in files:
        got, aerr = A.numeric_strings(f)
        static = {s for _, s in (got or [])}
        drawn, err = capture(f)
        nums = [s for s in drawn if is_numbered(s)]
        if not nums and not static:
            continue
        missed = [s for s in nums if s not in static]
        rows.append((f, static, nums, missed, err))

    print("%-46s %6s %6s %6s %6s" % ("脚本", "静态", "上纸", "静态没", "状态"))
    print("-" * 88)
    T = [0, 0, 0]
    for f, static, nums, missed, err in rows:
        T[0] += len(static); T[1] += len(nums); T[2] += len(missed)
        print("%-46s %6d %6d %6d %6s" % (f.replace(ROOT + "/", ""), len(static), len(nums), len(missed),
                                         "✗ " + err[:12] if err else "ok"))
    print("-" * 88)
    print("%-46s %6d %6d %6d" % ("合计", T[0], T[1], T[2]))
    if T[1]:
        print("\n静态扫出来的 %d 处里，真上纸 %d 处；"
              "纸上另有 %d 处静态完全没点到。" % (T[0], T[1] - T[2], T[2]))
    print("\n静态没点到、但确实上了纸的（前 30 条）：")
    n = 0
    for f, static, nums, missed, err in rows:
        for s in missed:
            if n >= 30:
                break
            print("  %-28s %s" % (os.path.basename(f)[:28], s[:64]))
            n += 1


if __name__ == "__main__":
    main()
