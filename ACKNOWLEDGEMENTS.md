# 致谢与来源

## 参考实现

好奇心的三个评分权重（未知 0.5 / 接触 0.3 / 稀缺 0.2）与「做过两次即退出候选池」的
入场条件，转写自 `beijingwahw/dsh-proactive` 的 `src/curiosity-engine.ts`（MIT）。

该实现是另一套运行时的插件，无法直接安装到本项目，因此按其源码逐字转写而非引用。

## 运行时

- [OpenClaw](https://github.com/openclaw/openclaw) — 插件宿主、钩子、工具注册、cron 调度。

## 未使用的依赖

本项目 `package.json` 无 dependencies。字符 n-gram 检索、情绪衰减、关系计算、实体
抽取全部为自行实现。

## 命名

本仓库里的角色用 `<角色名>` 指代。它是一位长期运行的 agent 所依赖的代码与规则的公开版本。
