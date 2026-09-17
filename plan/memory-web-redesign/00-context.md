# 记忆浏览器重设计 · 冻结共同上下文(v1,2026-09-18)

> 本文档是 `packages/memory` 前端重设计的**共享契约**。四份设计文档(01-设计系统 / 02-公共层与壳 / 03-视图迁移与交互修复 / 04-图谱)都以此为准。
> 路径约定:前端资产在 `packages/memory/src/web/assets/`;服务端在 `packages/memory/src/web/*.ts`;测试在 `packages/memory/test/web/`。

## 0. 背景与目标(明月拍板)

现状问题(实测截图确认):
1. **反人类**:确认 modal 无关闭按钮(`edit.js` `openDialog`,header 只有 `<strong>`);raw 页暴露 `from raw_id`/`to raw_id` 参数名与完整 session UUID;URI 处处截断成 `id…`;库管理页路径逐字符竖排折行;元数据(`★9`/`manual`)裸文本散落。
2. **样式丑**:整站 pico.css 默认外观,无设计语言。
3. **功能缺**:无图谱可视化(明月点名要这个)。统计仪表盘/表格视图**本次不做**。

技术决策(主代理研究后定,明月确认倾向零构建):
- **保持零依赖、零构建、纯 ESM**。理由:图谱用 canvas 2D 自实现力导向(~300 行)可行;膨胀根因是"每视图手写一切"而非缺框架;保持"改静态文件即刷新生效"的协作体验。
- **视觉方向**:深色优先的专业工具风(TablePlus/Linear 的信息密度感),但保留现有 auto/light/dark 三态主题(CSS variables 实现成本低,全保留)。
- **代码减负**:抽公共层消灭重复;`edit.js` 的 905 行 `mountEditor` 巨函必须拆解。行数目标:视图层总行数下降 ≥25%(不含新增图谱),质量优先于行数本身。

## 1. 边界:什么能动、什么不能动

### 不动(服务端骨架)
- `server.ts` / `security.ts` / `discovery.ts` / `registry.ts` / `db-path-policy.ts` / `runtime.ts` / `cli.ts` 的既有逻辑。
- `serialize.ts` 的**白名单 DTO 原则**(每个 DTO 必须显式 `to*DTO`,禁止 `{...node}` 透传;null-prototype row 只按列名读)。
- `routes.ts` 的 ROUTES 表机制与多库 `?db=` 注入逻辑。
- 唯一例外:04-图谱允许**新增**一个 `GET /api/graph` 路由 + `serialize.ts` 新 DTO(见 §4)。

### 动(前端全量)
- `assets/` 下全部文件可改可删可增。`vendor/pico.min.css` 去留由 01-设计系统 决定(倾向:去掉,自建 token;若保留必须说明理由)。

## 2. 冻结不变量(现有测试盯着,违反即破坏)

1. **纯 ESM、零 npm 依赖、零构建**:浏览器原生 `import()`,无 bundler、无 import map、无 JSX/TS(资产是 .js)。
2. **绝不 innerHTML**:一切来自 DB 的文本走 `textContent` / DOM API(全站硬规则)。⚠️ 更正(2026-09-18,D2 核实):test/web 下**没有** innerHTML 自动哨兵,snippet-guard.test.ts 只测服务端;规则仍按硬规则执行,新设计文档应建议补一条前端哨兵。
3. **读路径零 POST**;写请求只经 `ctx.api.post`(即 `app.js` 的 HTTP 层)。
4. **`edit.js` 无裸 `fetch(`**;所有取数走共享 HTTP 层(`?db=` 注入的唯一注入点)。
5. **`views/url.js` 是 `?db=` 的唯一实现**;`views/tree-cache.js` 同为无副作用纯模块。判据:`node -e "import('./views/url.js')"` 不抛。
6. **模块顶层副作用分层**:新公共层若被纯模块 import,则它自身不得有顶层 `document` 访问(参考 app.js 顶部注释的教训)。
7. **多库 N+1 禁令**:库列表一次拿全,禁止每库发一请求数节点。
8. **管理端点(`/api/databases*`)永不带 `?db=`**。
9. **事件契约**:`memory:changed`(DOM CustomEvent,写后刷新信号,壳监听不派发)、`mw:toast` 保持不变。
10. **路由**:hash 路由(`#/tree`、`#/node?uri=`…),`parseHash`/`navigate` 语义不变;**新增 `#/graph`**。
11. **主题**:三态 auto/light/dark,localStorage key `mw:theme`,首帧前应用(无闪白)。
12. **`mw-` CSS 前缀**保持。
13. **ctx 是视图唯一共享面**(`app.js` `buildCtx`):视图不得直接 import app.js 的 get/post(通过 ctx.api)。现有 `ctx.api.*` 方法名一个不删(下游哨兵测试/视图在用);**新增** `ctx.api.graph(q)`。
14. **静态哨兵测试的处理方式**:受改动影响的哨兵断言(如数 `var(--pico-` 出现次数之类)允许更新**字面量**,但断言**意图必须保留**;意图确属过时的(如 pico 相关)在设计中单列一节说明后删除。禁止"为了让测试通过而阉割守卫"。

## 3. 交互修复清单(冻结,逐项验收;03 文档负责落地方式)

| # | 修复 | 验收 |
|---|---|---|
| F1 | 所有 modal(现 2 处重复实现 + 未来所有)右上角 × 按钮;点遮罩可关(可按调用方禁用);Esc 关闭(原生已有);关闭后焦点归还触发元素 | 无"只能取消"的 modal |
| F2 | URI 完整可读:等宽字体,长 URI 单行省略 + `title` 全文;点击复制完整 URI 并 toast | 任何视图不再出现 `id…` 式截断 |
| F3 | 全局 URI 跳转:顶栏输入框,粘贴 `domain://path` 直达节点页,无效时行内报错 | — |
| F4 | raw 页去参数名:`from/to raw_id` 改为"定位"输入(接受 `#123` 或 `123`);session 选择器显示人类标签(起始时间 + 首条消息摘要),UUID 仅详情中等宽展示 | 无 API 参数名词暴露给用户 |
| F5 | 库管理页:路径 monospace + 单行省略 + title;行布局重排,不逐字折行 | — |
| F6 | 元数据徽章:importance 色阶徽章(9-10/7-8/4-6/0-3 四档)、source 徽章(manual/auto/import)、stub 灰纹样式 | — |
| F7 | 面包屑:节点页/编辑页顶部 `domain://a/b/c` 逐级可点 | — |
| F8 | 树视图:节点行显示完整段名(最后一段主视觉,前缀弱化),child_count、disclosure 指示 | — |
| F9 | 搜索结果关键词高亮(先核实现状是否已有,没有则补) | — |
| F10 | 图谱视图入口在侧栏(独立于"系统视图"分组之上) | — |

## 4. 图谱契约(04 文档细化,此为骨架)

- **端点**:`GET /api/graph?domain=&limit=`。响应(经 serialize.ts 白名单):
  `{ world_time, nodes: [{node_id, uri, domain, importance, is_stub, label(=uri 末段), parent_uri}], edges: [{source_id, target_id, kind, dangling}], aliases: [{alias_uri, target_node_id, dead}] }`。
  无 `domain` 时返回域清单 + 每域节点数(供前端先选域);`limit` 默认值由 04 定(防全库拉爆)。查库 SQL 只读、走既有 store 只读方法或新增只读查询,**不写 store 层业务**。
- **前端**:`assets/views/graph.js`,canvas 2D 力导向布局自实现(无 d3)。域着色、节点半径 ∝ importance、悬停高亮邻接、点选弹详情卡(可跳节点页)、拖平移、滚轮缩放。125 节点全库流畅;`requestAnimationFrame` 迭代至稳定即停(不空转烧 CPU);dispose 时取消 rAF 与事件。dangling 边灰色、alias 虚线。
- canvas 需处理 devicePixelRatio 与容器 resize。

## 5. 设计文档产出要求(对四个子代理的共同要求)

- 每份文档**必须**带现状引用(`file:line`)、组件/模块 API 签名、迁移步骤、受影响测试清单(意图保留/字面量更新/删除三类)、逐条验收标准。
- 长度不设上限,比实现文件长是正常的。写清"为什么",不堆"是什么"。
- 发现与 00-context 冲突的事实,**停下来用 hub 汇报主代理**,不要自行改契约。
- 跳过全量测试/构建/lint;设计阶段只读源码。

## 6. 现状速览(主代理已核实的事实,子代理可直接引用)

- 前端资产行数:app.js 847 / app.css 257 / index.html 39;views/:edit.js 1699(mountEditor 单函 905 行,L465-1370)、tree.js 784、views.js 657、raw.js 590、node.js 480、temp.js 420、databases.js 313、search.js 279、audit.js 225、url.js 110、tree-cache.js 57。
- `edit.js` L324 `openDialog` 与 L1657 第二处 dialog:两处重复 modal 实现,均无 × 按钮。
- `edit.js` L378 自定义 `h()` 与 `app.js` `el()` 重复;⚠️ 实为 **6 份**(D2 核实):app.js:97 `el()` + edit.js:378 + views.js:52 + audit.js:49 + raw.js:36 + temp.js:30。
- ⚠️ **现存 bug(D2 浏览器实证)**:toast 系统从未工作——app.js:252 在 `document` 上派发 `mw:toast`,唯一监听挂在 `#mw-toasts`(后代元素,不在事件路径)。修复:监听改挂 document;修复后 toast 开始真正出现属预期行为变化。
- app.css 52 处 `var(--pico-*)`,vendor/pico.min.css 由 index.html L7 引入。
- API 面:GET meta/tree/node/search/temp/view/audit/revisions/raw/sessions/events;POST node、node/revise、node/forget、node/restore、node/relocate、edge、glossary、glossary/remove、awaken、world-time;GET/POST databases、databases/open、databases/create(routes.ts L1319-1345)。
- 系统视图名(views.ts L158):timeline / forgotten / recent / index / glossary / wakeup / diagnostic。
- NodeDTO/TreeNodeDTO/EdgeDTO/AliasDTO 形状见 serialize.ts L20-120;TreeNodeDTO 含 content_head/disclosure/child_count。
- 测试:test/web/ 下 sentinel 类(multi-db-frontend.test.ts 读源码断言)、行为类(multi-db-url.test.js 真跑 url.js/tree-cache.js)、dto-contract、snippet-guard、views-parity、disc-badge、multi-db-* 系列。跑法:repo 根 `./test.sh` 或包内 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/web/<file>`。
- 示例库:`~/projects/amio/elias/.pi/memory.db`(125 节点/5 域/100 raw/49 glossary,`~/projects/pi-memory-web --db ... --port 8791` 可复现现状)。
