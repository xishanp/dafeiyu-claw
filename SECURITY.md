# 安全

## 这个插件能做什么

它注册了 55 个工具，包括发消息、读写文件、执行命令。装上之后 agent 拥有这些
能力。**默认配置下它只对你在 `config.agents` 里列出的 agent 生效**，但这仍然
是很大的权限面。

## 审批闸门

`lib/approval.js` 实现了一个可选的审批层：被标记为高危的工具调用会被拦下，
请求转给 owner，由人决定。相关工具是 `dafeiyu_requests` 和 `dafeiyu_approve`，
一次性授权、10 分钟过期、用完即废。

要启用，在配置里打开 `autonomy` 相关项。不启用时所有工具直接可用。

## 这个仓库里没有的东西

- 没有 API key、token、密码、cookie
- 没有真实账号、群号、openid
- 没有真实地名、人名、文件路径

所有示例值都是占位符（`1000000001`、`wxid_example`、`/path/to/workspace`）。

## 报告漏洞

开 issue，或者如果涉及凭据泄露，直接联系仓库 owner。不要贴真实密钥。
