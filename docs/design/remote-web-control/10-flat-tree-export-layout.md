# Remote Web 阶段四：扁平树协议与 Export/Share 布局收敛

## 用户原话（2026-10-09，逐字）

> 这一棵会话树是有什么局限吗？我看见了 Unable to encode server protocol message: CBOR nesting depth exceeds configured limit of 64   你要不要去看看 /export html 和 /share 里面那个html是怎么做会话树的。以及其实我觉得web有很多东西都可以参考那个html的布局，我觉得都挺好。

## 现状与根因

- 最小复现：remote `get_tree` 返回 31 层单链时 `encodeServerMessage` 成功，32 层时报 `Unable to encode server protocol message: CBOR nesting depth exceeds configured limit of 64`。每个节点消耗 object + `children` array 两层，外层 response/result/tree 还会占深度。
- CBOR 默认 `maxDepth=64` 是不可信协议输入的安全边界（`packages/protocol/src/cbor/options.ts:5-16`），不得为业务树提高。
- `/export html` 注入 `SessionData.entries` 扁平表（每项已有 `parentId`），浏览器以 Map 建 parent-child 关系（`export-html/template.js:35-110`），再用显式 stack 扁平化（`:183-252`）；结构深度不进入 JSON/CBOR 嵌套。
- `/share` 没有独立 HTML：先 `ctx.session.exportToHtml(tmpFile)`，再上传同一 HTML 到 gist（`commands/builtins.ts:74-125`）。因此 export/share 的树与布局完全相同。

## 效果清单

1. 任意实际会话深度（至少 500 层回归）都能通过 `get_tree` 协议编码、解码和 web 渲染；不提高 CBOR 深度限制。
2. remote web 在浏览器本地从扁平表构树；孤儿节点视作 root，自 parent 视作 root，子项按 timestamp 稳定排序。
3. 桌面采用 export/share 的常驻树侧栏 + 可拖动调宽 + 搜索/过滤；小屏采用遮罩滑出侧栏。
4. 树只在真实分叉处增加视觉缩进，active path 优先、路径节点清晰、当前 leaf 单独高亮；长单链保持紧凑。
5. 消息布局收敛到 export/share：紧凑等宽排版、用户/custom 卡片、assistant 连续正文、工具结果独立折叠块；保留 remote 的 composer、模型切换、编辑、reroll、断线恢复。

## 冻结契约

### 协议

干净切换，删除递归 `SessionTreeNodeProjection`：

```ts
interface SessionTreeEntryProjection {
  id: string;
  parentId: string | null;
  kind: "user" | "assistant" | "tool" | "custom" | "compaction" | "branch_summary" | "other";
  customType?: string; // 仅 kind=custom
  label?: string;
  summary: string;
  timestamp: number;
}

get_tree result = {
  command: "get_tree";
  entries: SessionTreeEntryProjection[];
  leafId: string; // 空串 = 空会话
}
```

- schema 是一层 `Type.Array`，无 `Type.Cyclic`/`Type.Ref`/`children`。
- runtime 直接迭代 `SessionManager.getEntries()` 生成投影；通过 `getLabel(entry.id)` 取 label，不先调用 `getTree()`。
- server/client/runtime/testing fake/web 全量迁移；不保留 `tree` 兼容字段。

### 前端树模型

- `buildTree(entries)`：两遍 Map 建节点和 parent-child；孤儿/`parentId===null`/自 parent 为 roots；roots 和 children 按 timestamp、输入位置稳定排序。
- `flattenTree` 使用显式 stack，不递归；active path 通过 parentId 向上迭代得到。
- 过滤模式对齐 export/share：Default（隐藏 other）、No-tools（再隐藏 tool）、User、Labeled、All；搜索匹配 kind/customType/label/summary。
- 当前路径优先排序；节点点击仍调用宿主 `navigate_tree(entry.id)`，不在客户端猜 leaf。

### 布局

- DOM 采用 `#shell > aside#tree-sidebar + #sidebar-resizer + main#app`；桌面（内容真实装不下前）默认展开，宽度持久化；移动端 fixed drawer + overlay + 关闭按钮。
- 不照搬 export/share 的 `innerHTML` 渲染；继续纯 DOM 与既有 markdown 安全管线。
- 树面板实例与连接生命周期保持独立；快照/progress 不关闭侧栏、不重置搜索、过滤、宽度、scrollTop。
- 预算仍为 remote bundle raw ≤260KB。

## 验收

1. 协议测试：500 条父子单链 encode → decode roundtrip，默认 CBOR `maxDepth=64` 不报错。
2. tree model 测试：深链、分叉、孤儿、自 parent、active path、过滤与稳定排序。
3. 真实 TUI + browser：打开深会话树无协议错误；桌面侧栏、拖宽、搜索、过滤、分支导航；移动 viewport drawer；prompt/edit/reroll 回归。
4. 浏览器实际 surface 截图/DOM 检查；bundle ≤260KB；无控制台错误。

## 实现与验收记录（2026-10-09）

- 协议已干净切换为 `SessionTreeEntryProjection[]` + `parentId`；删除 TypeBox Cyclic/Ref 与 `children[]`。server/client/runtime/testing fake/web 全量迁移，无兼容双写。
- Runtime 直接迭代 `SessionManager.getEntries()`，不调用 `getTree()`；前端 `tree-model.ts` 以 Map + 显式 stack 组树/展开，过滤后把节点重挂到最近可见祖先。
- 布局收敛到 export/share：桌面常驻侧栏、拖宽与 localStorage 持久化、搜索、五种过滤、active path 优先、只在分叉处缩进；移动端 88vw 滑出侧栏 + 遮罩关闭；主会话区采用紧凑等宽、用户/custom 卡片、assistant 连续正文。
- 回归：协议 500 层 encode/decode roundtrip；前端模型 10,000 层无递归栈溢出，覆盖分叉、孤儿、自 parent、排序与过滤。最终范围 18 个测试文件、158 项测试全绿；五个受影响包构建通过。
- 真实 smoke：TUI 扩展追加 500 条 custom entry 后启动 `/remote start`；浏览器显示 `500 / 503 条 · 当前路径 503`，首尾 `deep node 0`/`deep node 499`，搜索定位第 499 条，协议/页面/console 零错误。桌面宽度 400→840 拖动与持久化通过；390×844 viewport 下侧栏为 343px（88vw），默认关闭、按钮打开、遮罩关闭通过。
- remote web bundle `app.js` 220,127 bytes，低于 260KB raw 预算。
