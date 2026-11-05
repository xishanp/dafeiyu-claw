# 贡献

## 提交前必须过

```bash
# 1. 语法
for f in plugin/index.js plugin/lib/*.js; do node --check "$f"; done

# 2. 测试
cd plugin && node --test test/

# 3. 清单一致性：声明的工具必须都实现了
python3 -c "
import json,re
j=json.load(open('plugin/openclaw.plugin.json'))
src=open('plugin/index.js').read()
d=set(j['contracts']['tools'])
i=set(re.findall(r'name:\s*[\"\']([a-z][a-z0-9_]+)[\"\']', src))
print('缺失:', d-i or '无')
"
```

## 三条硬规则

**一、改了提示词要在这里说明为什么。**

`prompts/` 下的文件直接决定她的行为。改一个词的语气，可能让某个工具从「可以
考虑」变成「必须做」。提交信息里写清改之前是什么行为、之后是什么行为。

**二、新工具必须同时改三处。**

`openclaw.plugin.json` 的 `contracts.tools`、`index.js` 的实现、`prompts/COGNITION.md`
里的说明。少任何一处，工具要么不注册，要么注册了但模型不知道怎么用。

**三、不要提交状态文件。**

`state/`、`memory/` 是本机运行数据。这个仓库只放代码和规则。

## 报告问题

贴 `state/probe.log` 里相关的几行。没有注入记录的 bug 报告无法定位——那个文件
就是设计出来回答「这个代码路径到底跑没跑」的。
