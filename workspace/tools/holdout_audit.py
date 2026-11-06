# -*- coding: utf-8 -*-
"""
holdout_audit.py —— 拿没看过的脚本，试一次前三层到底管不管用。

为什么要有这个：
claims_of.py 最后自己写着「分类规则是照着这同一批 34 条改出来的，
改一次对一次，那不是工具推出来的结论」。说对了没用，得真去跑一批没看过的。

那 34 条来自 capture.json 的 46 个脚本。work/ 下面另外还有 50 个
（_drafts 里的过程稿、onepot.py、audit/chart3-4），一次都没进过审计。
它们就是现成的留出集——虽然同一家人，但至少规则没见过它们。

一个必须处理的事：这些老脚本会往 assets/ 里写图。
直接跑会把 assets/first-error.png、assets/prune.png 覆盖掉。
所以这里不只拦 text，也把 Image.save 变成空操作——
只看纸上写了什么，不落盘。

用法：
    python3 tools/holdout_audit.py                 # 跑留出集，报分布
    python3 tools/holdout_audit.py --world         # 只列被判成「说世界」的
    python3 tools/holdout_audit.py --save-json work/audit/holdout.json
"""
import contextlib
import glob
import io
import json
import os
import runpy
import sys

from PIL import Image, ImageDraw

ROOT = os.path.expanduser("~/.openclaw/workspace")
sys.path.insert(0, os.path.join(ROOT, "tools"))


def unseen(covered):
    files = sorted(glob.glob(os.path.join(ROOT, "work", "**", "*.py"), recursive=True))
    skip = {"audit_prov.py", "canvas_capture.py", "paper_claims.py", "claims_of.py",
            "holdout_audit.py", "prov.py", "dateaudit.py", "mywords.py",
            "openers.py", "voiceprint.py"}
    out = []
    for f in files:
        rel = os.path.relpath(f, ROOT)
        if rel in covered or os.path.basename(f) in skip:
            continue
        out.append(rel)
    return out


def capture(path):
    """跑一遍，截下上纸的句子；不落盘。"""
    seen = []
    orig_text = ImageDraw.ImageDraw.text
    orig_ml = ImageDraw.ImageDraw.multiline_text
    orig_save = Image.Image.save

    def text(self, xy, s, *a, **k):
        if isinstance(s, str):
            seen.append(s.strip())
        return orig_text(self, xy, s, *a, **k)

    def mtext(self, xy, s, *a, **k):
        if isinstance(s, str):
            seen.append(s.strip())
        return orig_ml(self, xy, s, *a, **k)

    def discard(self, fp=None, *a, **k):
        return None

    ImageDraw.ImageDraw.text = text
    ImageDraw.ImageDraw.multiline_text = mtext
    Image.Image.save = discard
    cwd = os.getcwd()
    os.chdir(ROOT)
    # python x.py 会把脚本自己那一目录放进 sys.path；runpy.run_path 不会。
    # 少了这一步，20 个 from base import ... 的脚本一个都跑不起来（第一遍就栽在这）。
    here = os.path.dirname(os.path.join(ROOT, path))
    if here not in sys.path:
        sys.path.insert(0, here)
    # _drafts 里那批拼贴稿是从 work/collage 挪过来的，base.py 留在原地没跟着走。
    # 把它们当档案处理：借一下原地的 base，不往 _drafts 里补文件。
    for spare in (os.path.join(ROOT, "work/collage"),):
        if spare not in sys.path:
            sys.path.append(spare)
    err = None
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(os.path.join(ROOT, path), run_name="__main__")
    except SystemExit:
        pass
    except Exception as e:
        err = "%s: %s" % (type(e).__name__, e)
    finally:
        ImageDraw.ImageDraw.text = orig_text
        ImageDraw.ImageDraw.multiline_text = orig_ml
        Image.Image.save = orig_save
        os.chdir(cwd)
        if here in sys.path:
            sys.path.remove(here)
    return list(dict.fromkeys(seen)), err


def main():
    covered = {e["py"] for e in json.load(open(os.path.join(ROOT, "work/audit/capture.json"),
                                               encoding="utf-8"))}
    import paper_claims as P
    import claims_of as C

    files = unseen(covered)
    print("留出集：%d 个脚本（capture.json 里没有的）\n" % len(files))

    rows = []
    kinds = {}
    whos = {}
    for rel in files:
        drawn, err = capture(rel)
        nums = [s for s in drawn if P.kind(s) != "no-number"]
        kept = [s for s in nums if P.kind(s) == "world"]
        for s in nums:
            kinds[P.kind(s)] = kinds.get(P.kind(s), 0) + 1
        for s in kept:
            whos[C.who(s)] = whos.get(C.who(s), 0) + 1
        rows.append({"py": rel, "drawn": len(drawn), "numbered": nums,
                     "world": kept, "err": err})

    print("%-52s %5s %5s %5s  %s" % ("脚本", "上纸", "带数", "说世界", "状态"))
    print("-" * 92)
    T = [0, 0, 0]
    for r in rows:
        T[0] += r["drawn"]; T[1] += len(r["numbered"]); T[2] += len(r["world"])
        print("%-52s %5d %5d %5d  %s" % (r["py"][5:], r["drawn"], len(r["numbered"]),
                                         len(r["world"]), ("✗ " + r["err"][:18]) if r["err"] else ""))
    print("-" * 92)
    print("%-52s %5d %5d %5d" % ("合计", *T))

    print("\n第二层（paper_claims.kind）在留出集上的分布：")
    for k, v in sorted(kinds.items(), key=lambda x: -x[1]):
        print("  %-10s %4d" % (k, v))

    print("\n第四层（claims_of.who）在留出集上的分布：")
    for k, v in sorted(whos.items(), key=lambda x: -x[1]):
        print("  %-10s %4d" % (k, v))

    if "--world" in sys.argv or True:
        print("\n被判成「说世界、却没交代出身」的，全部列出来：")
        n = 0
        for r in rows:
            for s in r["world"]:
                if C.who(s) != "world":
                    continue
                n += 1
                print("  %-30s %s" % (r["py"].replace("work/", "")[:30], s[:90]))
        print("\n共 %d 条 —— 这个数没有人事先看过。" % n)

    if "--save-json" in sys.argv:
        p = sys.argv[sys.argv.index("--save-json") + 1]
        json.dump(rows, open(os.path.join(ROOT, p), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        print("\n写进 %s" % p)


if __name__ == "__main__":
    main()
