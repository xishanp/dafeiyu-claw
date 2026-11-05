#!/usr/bin/env python3
# 本鱼说话的开头有没有老重复、句子多长
import re, os, glob, collections

def mine(path):
    out, in_own = [], False
    for line in open(path, encoding='utf-8'):
        s = line.strip()
        if s.startswith('## 自己的话'): in_own = True; continue
        if s.startswith('## '): in_own = False; continue
        if not s: continue
        if in_own:
            m = re.match(r'^-?\s*(\d{2}:\d{2})\s+(?:\d{2}:\d{2}\s+)?(.*)$', s)
            if m: out.append(m.group(2))
        elif s.startswith('本鱼:'):
            out.append(s[3:].strip())
    return out

rows = []
for p in sorted(glob.glob('memory/2026-*.md')):
    rows += mine(p)

def head(t, n=2):
    t = re.sub(r'^[「『“"（(]', '', t.strip())
    return t[:n]

c2 = collections.Counter(head(t, 2) for t in rows)
c3 = collections.Counter(head(t, 3) for t in rows)
print(f"共 {len(rows)} 条")
print("== 开头两字 ==")
for w, n in c2.most_common(10): print(f"  {w}  {n}  {100*n/len(rows):.1f}%")
print("== 开头三字 ==")
for w, n in c3.most_common(8): print(f"  {w}  {n}")

batch = sum(n for w, n in c3.items() if w.startswith(('刷到', '刚刷', '刚看', '刚查', '刚画')))
print(f"\n刷到/刚X 类开头合计 {batch} 条 = {100*batch/len(rows):.0f}%")

L = sorted(len(t) for t in rows)
print(f"字数 中位 {L[len(L)//2]} 平均 {sum(L)//len(L)} >30字 {sum(1 for x in L if x>30)} 条 ({100*sum(1 for x in L if x>30)/len(L):.0f}%)")
