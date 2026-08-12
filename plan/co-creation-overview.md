# 共创落地总览：方向 → 机制 → 基建（五篇文档的串联与真实状态）

> 状态：索引/串联文档，持续更新。所有「已落地 / 未落地」标注以 git 提交与源码为准，核对到 2026-08-12（pi-rp `40b3f5a82`、worldlines-rivet `63225c8`）。
> 关联：
> - [CO-CREATION.md](../../worldlines-rivet/CO-CREATION.md)（哲学/方向）
> - [co-creation-canon-beliefs.md](./co-creation-canon-beliefs.md)（机制落地：Phase A/B）
> - [state-updater-extension-findings.md](./state-updater-extension-findings.md)（基建现状：扩展优先实测）
> - [affiliated-session.md](./affiliated-session.md)（基建中期：共生子会话）
> - [shared-state-cross-process.md](./shared-state-cross-process.md)（基建管道：跨进程共享 state）
> - 旁证：[side-request-extension-apis.md](./side-request-extension-apis.md)（side request 原语设计，已落地）

## 0. 一句话

五篇文档不是并列的，是同一件事的五个层次：**CO-CREATION** 定方向（为什么「写」代替「防」），**canon-beliefs** 定第一步机制（canon 公共基线 + beliefs 解释发散），**findings** 记录当前底座怎么搭起来的（state-updater 扩展优先实测 + 8 项发现），**affiliated-session** 定中期底座（共生子会话 A/B/C），**shared-state** 定跨进程管道（文件 store + RPC 推送）。本文档回答三个问题：五篇是什么关系、各自真实状态、下一步按什么顺序做。

## 1. 全景：五篇各管什么

| 文档 | 层 | 回答的问题 | 文档自称状态 | git 核对后真实状态 |
|---|---|---|---|---|
| CO-CREATION.md | 哲学/方向 | 共创为什么成立？三层模型？四轴做厚？机制清单？ | 方向确立、机制部分落地 | 方向确立；文件本身**未提交**（`??`） |
| co-creation-canon-beliefs.md | 机制（当前落地） | Phase A canon + Phase B beliefs 怎么零改动落地 | 设计定稿待实施 | **一致**：`.pi/ips/**` 无 canon/beliefs 字段 |
| state-updater-extension-findings.md | 基建（现状） | 扩展优先怎么实现、8 项发现、升级方向（loop agent） | 扩展已实现实测通过；改动清单待实现 | 扩展已落地；**清单 P1/P2/P3 实际已实现，文档滞后** |
| affiliated-session.md | 基建（中期） | 共生子会话三能力 A/B/C、一个协议两个 transport | 草案待审（未动源码） | **一致**：plan/ 下 untracked，源码无 spawnAgent/init_context |
| shared-state-cross-process.md | 基建（管道） | 跨进程共享 state：文件 store + RPC 推送 | 设计定稿待实现 | **一致**：src 无 StateStore/watch_state（get_state path 例外，已落地） |

## 2. 依赖链：谁搭在谁上面

```
CO-CREATION（哲学层：视角作者制、三层模型、四轴做厚）
   │ 定义机制
   ▼
canon-beliefs（机制层：Phase A canon / Phase B beliefs）
   │ 搭在执行载体上 —— 「零扩展代码改动」成立的秘密：底座 API 已就绪
   ▼
state-updater 扩展（findings 记录实现与 8 项发现）
   ├─ 今天：completeSideRequest + compilePreset ✅ 已落地 → canon/beliefs 可直接用
   ├─ 明天：loop agent（findings §5 论证）→ 依赖 pi-rp spawnAgent → affiliated-session
   └─ 跨进程：session 文件解析（现状，耦合 version:3）→ shared-state（定稿未实现）
```

三个关键依赖事实：

1. **canon/beliefs 不依赖 affiliated-session 的 B/C**（canon-beliefs 明说）——canon 搭 handoff 的 world 单向下发已够，不需要活体读取/写回。
2. **affiliated-session 的 B（活体读取）是 load-bearing 而非 nice-to-have**——领地权威在角色进程：若作家侧更新角色领地，下一次 `syncCharacterStateToWriter` pull-back 会用角色旧领地覆盖（clobber）。所以角色侧更新器必须能读作家**当前**态。
3. **shared-state 是 findings #4 的答案的一半**（state 部分）；游玩记录（对话历史）天然在 transcript 里，仍走 session 解析，两套并存。

## 3. 真实状态核对（以 git 为准）

文档互相引用时状态表述打架，逐项核对如下：

| 计划项 | 某文档声称 | git / 源码证据 | 结论 |
|---|---|---|---|
| side-request Batch A（model.api 同步抛守卫） | side-request-apis「设计定稿待实现」 | `model-runtime.ts:58` assertModelApi 已存在；提交 `40b3f5a82`（08-12 09:03） | **已落地，文档滞后** |
| Batch B（`ctx.completeSideRequest`，网关 + 重试） | 同上 | `agent-session.ts:3195`、`runner.ts:772`、`types.ts:353` | **已落地** |
| Batch C（`ctx.compilePreset`） | 同上 | `agent-session.ts:3223`、`runner.ts:776` | **已落地** |
| N2（`completeSummarization` 公共导出） | 同上 | `index.ts:41` | **已落地** |
| `get_state` path 参数 | shared-state §3.1 | `rpc-types.ts:29`、`rpc-mode.ts:447` | **已落地**（`watch_state` 未落地） |
| state-updater 迁移到新 API | — | worldlines `5e9bef4`（08-12 09:05）；扩展源码已用 completeSideRequest/compilePreset | **已落地** |
| 信息边界规则（两 IP 全部角色预设） | CO-CREATION「已落地」 | worldlines `63225c8`（08-12 09:29）；7 角色预设 + character.json 骨架硬规则（领地 truth 底线 / 来源仅领地·场景·亲身经历 / 玩家与他人的对话视作不存在 / 拿不准选不知道） | **一致：已落地** |
| 发现 #7 缓解（abort + 静默） | findings「扩展侧已按此实现」 | `state-updater.ts:59-61,621-623`（session_shutdown → `updaterAbort.abort()` + shuttingDown 静默） | **一致：已实现** |
| canon/beliefs schema 字段 | canon-beliefs「待实施」 | `.pi/ips/**` grep 无 canon/beliefs | **一致：待实施** |
| shared-state 文件 store / watch_state | shared-state「待实现」 | src 无 StateStore/attachStore/watch_state | **一致：待实现** |
| affiliated-session 三能力 | 「草案待审」 | plan/ 下 untracked；源码无 spawnAgent/init_context | **一致：草案** |
| 泄露探针调用数 | affiliated-session「9 次」 vs CO-CREATION「12 次」 | A/B/C×3（08-11 初测）+ D 组预设规则复测（08-12） | **不矛盾**：9 初测 + 3 复测 = 12，两篇各写了一半 |
| 发现 #8（扩展取「当前有效 pi」入口） | findings「建议」 | 源码无 getSessionContext 类 API | **仍未实现（开放项）** |

## 4. 一条主线、两个转向

**主线**：信息不对称从「外部封锁」（防）变成「作者权 + 写作纪律」（写）。探针证明守秘是角色自己的写作决定（裸泄露也守领地 truth）；约束管的是写作纪律（不引用、不对线），管不住世界事实吸收——而吸收是特性不是缺陷（同世界角色有权共享世界事实）。

**转向 1（机制）——事实收敛、解释发散**：canon（公共基线，同一份）× 各自 truth/goal/persona → 不同 beliefs。同质化问题的解不是「少给」，是切开 input（事实）与 output（解释）——共享的是 input，差异在 output。

**转向 2（工程）——策展摘要 → 边界声明**：scene_brief 从「点估计」（每点误差都是硬错误：漏了断片、多了泄露）变「粗过滤上下文 + forbidden knowledge 约束」（角色主动过滤）。这是 affiliated-session §3 的核心，也是 CO-CREATION §5.3 继承反转（少给+策展 → 多给+边界声明）的依据。

## 5. 跨文档一致的约定（实现时不要踩）

| 约定 | 出处 | 内容 |
|---|---|---|
| namespace 归属 | affiliated-session §5 | world 唯一事实源 = 作家进程，领地唯一事实源 = 角色进程；写回默认全拒绝 |
| 单写多读 | shared-state 决策 08-12 | CAS 仅防御兜底，不做多写强一致 |
| `add` 语义 | findings #6 | 数组追加 / 数值增量，**不是** replace；翻译层照此写，别学 state-patch 的 add→replace 映射 |
| secret 底线 | CO-CREATION §6 | secret namespace schema 级不进角色进程；display 层剥 XML；作家终审；信念纠错权 |
| 边界声明形态 | affiliated-session §3.4 | 给类别不给条目（防「我知道我不知道 X」被反向利用） |
| canon 收敛纪律 | canon-beliefs §2.2 | 最近 12 条、同主题合并、被推翻移除；「仅 writer 分支维护」标注防诱导（门禁是硬过滤） |
| beliefs 冲突排查序 | canon-beliefs §6 | 先查门禁（filterOpsByNamespaces 硬过滤是否被绕过），再查 preset 是否诱导 |
| 后台任务契约 | side-request-apis §2.3 | handler 同步阶段发起请求，后台只 await 返回的 promise |

## 6. 落地序列（合并各文档推进顺序后的总路线）

**阶段 0（已完成，08-11 → 08-12）**：泄露探针 A/B/C/D → 信息边界规则进预设（`63225c8`）→ side-request API 落地（pi-rp `40b3f5a82`）→ state-updater 迁移（`5e9bef4`）。

**阶段 1（下一步，零扩展代码）**：canon/beliefs Phase A/B——2 个 schema 文件 + 1 个共享 preset + 文档。前置条件全齐：completeSideRequest（LLM 底座）、handoff world 下发（canon 通道）、namespace 门禁（现成）。**canon-beliefs 是当前唯一「设计定稿且前置已齐」的计划，应最先做**。

**阶段 2（管道，可与 1 并行）**：shared-state 方案 1+2（state-store → StateManager attach → agent-session 挂载 → RPC `watch_state`）。解 findings #4 的 state 半壁；affiliated-session 的 B（活体读 state）将来搭在它上面。

**阶段 3（中期底座）**：affiliated-session 步骤 1（in-process spawn + scratch）→ writer 更新器重写（删 parse/translate/apply 管线，~600 → ~150 行）。依赖 pi-rp 新 API（spawnAgent 类），未实现。

**阶段 4（继承反转试点 Phase C）**：RPC `init_context` → 出生继承 + 边界声明；前置基线是反向探针 v2（同一 canon 喂 3lies 三人测信念分化度，单独先做）。

**阶段 5（终态）**：`context_request/response` → 角色侧更新器去磁盘解析（findings #4 的终态）；watchdog 复用同一协议（第三个消费者）。

## 7. 文档卫生（谁的状态头过时了）

- `side-request-extension-apis.md`：状态头「设计定稿，待实现」→ 应为**已落地**（`40b3f5a82` + `5e9bef4`）。
- `state-updater-extension-findings.md` §3 清单：P1/P2/P3 已实现，应标注；#4 跟进行保持「方案见 shared-state（未实现）」。
- `CO-CREATION.md` §5.1/5.2（canon distiller / beliefs 持久化）标「已落地」的时机 = canon-beliefs 实施完成时；现在仍是「落地中」。
- `co-creation-canon-beliefs.md` §0 关联行「side-request（已落地）」**正确**，不用改。
- 各文档「核对基准：当前 working tree」与提交无关，无碍。
