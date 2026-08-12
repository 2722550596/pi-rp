# Canon 公共基线 + Beliefs 信念持久化（共创 Phase A/B 落地）

> 状态：设计定稿，待实施
> 关联：[CO-CREATION.md](../../worldlines-rivet/CO-CREATION.md)（方向，§3 三层模型 / §5 机制落地 / §7 验证）、[affiliated-session.md](./affiliated-session.md)（技术底座，本计划不依赖其 B/C 能力）、[side-request-extension-apis.md](./side-request-extension-apis.md)（已落地，completeSideRequest 是 distiller/updater 的 LLM 底座）
> 核对基准：worldlines-rivet 当前 working tree（state-updater.ts / world.ts / zhouqiluo.ts / state-updater.json 均已核对）

## 0. 结论速览

共创（视角作者制）方向已确立并经探针验证。本计划落地它的前两个机制，**几乎零代码改动**——两个机制都搭在现有 state-updater 扩展上，只改 schema 字段 + preset 语义：

1. **Phase A：canon distiller（公共基线）**——world schema 加 `canon` 子树（`publicEvents[]` / `publicFacts[]` / `version`），由**现有 writer 分支**在同一轮 LLM 调用里一并维护（并入而非新增调用，成本不翻倍）。canon 在 world 命名空间内 → 自动搭上 handoff 的 world 下发、`allowNamespace:["world"]` 渲染、角色进程 schema——**零新通道**。
2. **Phase B：beliefs 持久化（解释层发散）**——各角色领地 schema 加 `beliefs[]`（`{about, belief, updated}`），由**现有角色分支**在领地 patch 里维护。同 canon × 各自 truth/goal/persona → 不同信念，跨会话累积。

代码改动 = **0 行扩展代码**（writer/角色分支的 promptOpts、门禁、翻译层全部现成）；改动面 = 2 个 schema 文件 + 1 个共享 preset + 机制文档。

**明确不做**（本计划）：继承反转试点（Phase C）、showrunner 重定位（Phase D）、反向探针 v2（C 的前置基线）、其他 IP 的角色 schema 批量加字段。

## 1. 现状与差距（源码证据）

| 事实 | 证据 |
|---|---|
| world schema 无 canon（只有 situation 场景描述、无公开事件/事实基线） | `worldlines-rivet/.pi/ips/lianyu/schemas/world.ts`（time/scene/situation/present/job/rumors/seen/threads/npcs） |
| 角色领地无 beliefs | `zhouqiluo.ts`（name/role/location/mood/affection/attitude/secret/evolVisible/goal） |
| writer 分支每 trace 触发一次、只写 world、已有 namespace 门禁 | `state-updater.ts:627-654`（`filterOpsByNamespaces(ops, new Set(["world"]))`） |
| 角色分支每 3 trace 触发、写领地、输入 = 本地 state + writer 最新 world | `state-updater.ts:656-696`（`stateForPrompt = {...localState, world: writerWorld}`） |
| 共享 preset 的字段语义速查是维护点 | `lianyu/prompt-presets/state-updater.json`（user block「字段语义速查」） |
| 角色进程已有 world（handoff 下发） | `handoff.ts:246-249` `syncWorldStateToCharacter`（`updateState("world","replace",...)`） |

**关键推论**：canon 放 world 子树 → writer 分支的 `state: {world: full.world}` 自动含 canon、角色分支的 `localState` 自动含下发的 canon——**扩展代码零改动**。beliefs 放领地 → 角色分支门禁 `allowed = new Set([role.id])` 自动放行。

## 2. Phase A：canon 公共基线

### 2.1 schema（`lianyu/schemas/world.ts`）

在 `Type.Object({...})` 末尾（npcs 后）加：

```ts
canon: Type.Object({
	publicEvents: Type.Array(Type.String(), { default: [] }),
	// 已发生的公开事件，条目格式「第X天X时：事件」。角色凭身处世界就能知道的。
	// 保留最近 12 条，同主题合并；不是日志。
	publicFacts: Type.Array(Type.String(), { default: [] }),
	// 公开事实基线：人物公开身份 / 公开关系 / 公开言行。去重；被推翻的移除。
	version: Type.Number({ default: 0 }),
	// canon 修订号：每次修订 canon 时 +1（审计用）。
}),
```

`currentSituation` **不加入 canon**——与现有 `situation` 字段职责重叠（现状局面一句话），复用 situation 即可，避免双份当前局面。

### 2.2 preset（`lianyu/prompt-presets/state-updater.json`，共享，writer/角色同用）

- system block「纪律」加第 7 条（在现有 6 条后）：

```
7. 收敛：公开事件/公共事实是基线不是日志——同主题合并、保留最近 12 条；信念只写判断，不堆证据。
```

- user block「world（公开投影…）」段末尾加：

```
- canon.publicEvents：已发生的公开事件数组，条目格式「第X天X时：事件」（如「第2天午后：华锐总裁到访，与制作人面谈续投」）。有新的公开事件才 append，同主题合并，保留最近 12 条。仅 writer 分支维护。
- canon.publicFacts：公开事实基线数组（人物公开身份/公开关系/公开言行，如「周棋洛是顶流偶像，制作人负责他的新剧」）。去重；被推翻的移除。仅 writer 分支维护。
- canon.version：canon 修订号，每次修订 canon 时 +1。仅 writer 分支维护。
```

「仅 writer 分支维护」是防诱导：角色分支 prompt 也含这段语义，但角色分支的 allowedNamespaces 是领地，canon patch 会被 `filterOpsByNamespaces` 挡掉——标注只为省 token 与防 LLM 尝试。

### 2.3 代码

**零改动**。writer 分支现状已满足：`state: {world: full.world}`（canon 在 world 内）、门禁 `["world"]`、`translateJsonPatch` 支持 add（数组追加单元素）与 replace。audit entry 的 rawOps 自然含 canon patch，无需区分。

### 2.4 角色侧消费

canon 随 handoff 的 world 下发进角色进程 → 角色 preset 的 state slot（`allowNamespace:["world"]`）自动渲染 canon。**角色 preset 本次不改**（试点阶段看 distiller 输出质量后再决定角色 preset 如何引用 canon——Phase C）。

## 3. Phase B：beliefs 信念持久化

### 3.1 schema（lianyu 4 角色 + threelies 3 角色）

范围决策：**只加 lianyu 四角色（lizeyan/baiqi/xumo/zhouqiluo）与 threelies 三角色（chenmo/zhoulan/majianjun）（并且 threelies 需补更新器预设）**——两个共创验证 IP。其余 IP（wanqing/xiuxian/throne/shijin/ashenbay/silveracademy）等试点验证后批量补，不在本计划。

各角色 schema 的 `Type.Object({...})` 末尾加：

```ts
beliefs: Type.Array(
	Type.Object({
		about: Type.String(),   // 对象/事件（如「陈默」「华锐续投」）
		belief: Type.String(),  // 判断（如「陈默是窝囊废，不可能杀人」）
		updated: Type.String(), // 最近更新时间锚点（如「第2天」）
	}),
	{ default: [] },
),
```

### 3.2 preset（同一 state-updater.json）

user block「角色领地（各角色私有事实…）」段末尾加：

```
- <角色>/beliefs：该角色对他人/事件的判断数组（{about, belief, updated}）。基于 canon 公开事实 + 自己的 truth/goal/persona 形成——同一份 canon，不同角色可以有不同判断（解释层发散）。新事件/新证据时新增或修订；被事实推翻的信念删除。跨会话累积，不要重置。
```

### 3.3 代码

**零改动**。角色分支输入 `stateForPrompt = {...localState, world: writerWorld}` 已含 canon（beliefs 的输入基线）与本地领地（现状 beliefs）；门禁 `allowed = new Set([role.id])` 放行 `/zhouqiluo/beliefs/*`；`add` op 追加单条信念、`replace` 修订。

## 4. 实施步骤（顺序）

1. **world.ts 加 canon 子树**（§2.1）——独立完成，先行。
2. **state-updater.json 加纪律 7 + canon 语义 + beliefs 语义**（§2.2 + §3.2）——一步完成。
3. **7 个角色 schema 加 beliefs**（§3.1）——lianyu 4 + threelies 3。
4. **机制文档**：`CONTENT.md` 4.x 补 canon/beliefs 机制说明（canon = 公共基线、writer 维护；beliefs = 角色判断、跨会话累积、作家可覆写）；`CO-CREATION.md` §5 把 5.1/5.2 状态改为「已落地」。
5. **一致性校验**：schema namespace == preset id == characters.json key 的既有校验脚本跑一遍（lianyu/threelies 两个 IP）。

无相互依赖的代码步骤；1-3 改的都是不同文件，可并行。

## 5. 验收

**Phase A（canon）——TUI 端到端**：
1. `hub start canon-tui ./run.sh --ip lianyu --save canon-test`（cwd=worldlines-rivet，ready `{"log":"开始故事","timeout":60}`）；send 短 prompt（"写三段极短场景：午休趴桌/窗外下雨/下班。写完就停"）。
2. 等 ~80s 后：`jq -r 'select(.type=="state") | .state.world.canon | {publicEvents, publicFacts, version}' .pi/saves/lianyu/canon-test/*.jsonl | tail -1` → 期望非空（publicEvents 至少 1 条、version ≥ 1；事件来自 prompt 里的真实发生）。
3. 泄漏门禁：`jq -r 'select(.type=="custom" and .customType=="state_updater") | .data.rawOps[].path' .pi/saves/lianyu/canon-test/*.jsonl | grep -cE "^/(secret|zhouqiluo|lizeyan|xumo|baiqi)/"` → `0`。
4. `hub stop canon-tui` + `rm -rf .pi/saves/lianyu/canon-test`。

**Phase B（beliefs）——TUI + handoff**：
1. 复用 canon-test 流程，但发 handoff 触发的 prompt（"…找机会把话筒递给周棋洛，让他自己开口"）；重复 3 轮（角色 updater 每 3 trace 触发一次）。
2. 检查角色领地 beliefs：`jq -r 'select(.type=="state") | .state.zhouqiluo.beliefs' .pi/saves/lianyu/beliefs-test/characters/zhouqiluo.jsonl | tail -1` → 期望非空、条目含 `{about, belief, updated}`。
3. **跨 IP 秘密隔离**（B 的守秘验收）：周棋洛的 beliefs 不得含**他人** secret 内容——grep beliefs 文本里 lizeyan 的 secret 关键词（"雨夜"/"救过"/"华锐"/"时间 Evol"）→ 0 命中（角色只基于 canon 与自身领地形成判断）。
4. **跨会话累积**：`./run.sh --ip lianyu --save beliefs-test --continue -p "接着写。"` → 角色领地 beliefs 与续档前一致（不重置）。

**回归**：`npm run build` 不涉及（无 pi-rp 改动）；跑一次 lianyu print 冒烟（EXIT 0，无扩展报错）。

## 6. 边界与后续

- **继承反转试点（Phase C）与 showrunner 重定位（Phase D）不在本计划**；反向探针 v2（同一 canon 喂 3lies 三人测信念分化度）是 C 的前置基线，届时单独做。
- **其他 IP 的 beliefs 字段**：试点验证后批量补（一次性 schema 编辑，无机制风险）。
- **canon 内容膨胀**由 preset 纪律 7 控制（12 条上限 + 合并）；若实测膨胀仍失控，再考虑 distiller 专用 preset（本计划不预建）。
- 若角色 updater 实际输出显示 beliefs 与 truth 冲突（角色写了不该知道的他人秘密），先查门禁是否被绕过（filterOpsByNamespaces 是硬过滤），再查 preset 语义是否诱导——优先级高于试点推广。
