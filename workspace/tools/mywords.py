#!/usr/bin/env python3
# 把日记里的「本鱼自己说的话」从机器流水里捞出来，按天统计
import re, os, json, glob

MEM = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'memory')
LOG = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|^\s*$|^- \d{2}:\d{2} (刚|今天|现在)?\s*$')

def scan(path):
    own, said, mach = 0, 0, 0
    in_own = False
    for line in open(path, encoding='utf-8'):
        s = line.rstrip('\n')
        if s.startswith('## 自己的话'):
            in_own = True; continue
        if s.startswith('## '):
            in_own = False; continue
        if not s.strip():
            continue
        if in_own:
            own += 1
        elif re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:', s.strip()):
            mach += 1
        elif s.startswith('本鱼:'):
            said += 1
    return own, said, mach

rows = []
for p in sorted(glob.glob(os.path.join(MEM, '2026-*.md'))):
    own, said, mach = scan(p)
    rows.append({'day': os.path.basename(p)[:10], 'mine_own': own, 'mine_said': said, 'machine': mach})
print(json.dumps(rows, ensure_ascii=False, indent=1))
t_own = sum(r['mine_own'] for r in rows); t_said = sum(r['mine_said'] for r in rows); t_m = sum(r['machine'] for r in rows)
print(f"总计 自己的话 {t_own} 条 / 说出口 {t_said} 条 / 机器流水 {t_m} 条  我的占比 {100*(t_own+t_said)/(t_own+t_said+t_m):.1f}%")
