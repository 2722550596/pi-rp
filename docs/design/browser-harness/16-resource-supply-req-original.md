# 资源供给补齐：需求原话

## 用户原话（原文，不改写）

```text
这些缺失是仅自动加载路径被阻断，但arg自定义加载无误，还是所有都不行？
```

```text
那个还差不多，至少依赖ui.notify的rpc不至于no op全丢了。纯tui的东西，浏览器本身也消费不到，用的是自己的前端。以及主题本身只影响tui，关系也和浏览器不大。这种程度的缺口才能算是不算缺口。但是刚才那个自定义预设 opening state schema必须想办法补救，特别是preset。你可以去派一个子代理看这个典型下游 \\wsl.localhost\Ubuntu\home\yoshix7ti\projects\worldlines-rivet 看它如果做浏览器本地化后会有什么问题，这样才能让你看得更清楚这个浏览器引擎的缺陷
```

## 注释（非原文）：效果清单

- Browser-only 的纯 TUI 绘制功能可以不提供；Browser 宿主使用自己的前端。RPC 的扩展 UI 通道不得因移除 TUI renderer 而被静默变成 no-op。
- Browser 必须能够供给自定义 prompt preset、opening 与 state schema；prompt preset 是最高优先级。
- 以 worldlines-rivet 浏览器本地化作为真实下游，核实它使用的资源、注入方式、启动顺序和可见玩法；不能仅凭 pi-rp 内部 API 推断需求。

## 注释（非原文）：解法清单与前提

- 用户建议先派子代理检查 `worldlines-rivet` 下游，以识别 Browser engine 的实际契约缺口；该检查用于收集事实，不预设最终实现方式。
- 需要核实的前提：下游是否将 preset/opening/schema 内容以内存参数传入、从 OPFS/工作区发现，或依赖 pi-rp 的磁盘默认目录；其浏览器启动是否复用 session、扩展与工作区资源。
- 设计方案应以“现有下游玩法资源在 Browser 中可被正确发现/注入并生效”为验收结果，不把“参数里有一个 ID”视为资源已加载。
