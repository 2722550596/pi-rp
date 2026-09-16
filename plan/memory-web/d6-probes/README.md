# d6-probes — D6（`26-渲染与测试.md`）的实测探针

归档自 `/tmp`（主 agent 的 tmpfs 纪律）。**8 个文件**，对应 `26-渲染与测试.md` §13 自检回执里的各条证据。

## 跑法（**实测**）

**全部探针都从仓库根跑，命令统一为**：

```bash
cd <repo-root>            # /home/yoshix7ti/projects/pi-rp
node --experimental-strip-types plan/memory-web/d6-probes/<探针>
```

（`probe-diff.mjs` 是纯 `.mjs`，去掉 `--experimental-strip-types` 亦可。）

| 探针 | import 形态 | 备注 |
|---|---|---|
| `probe-diff.mjs` | 无 import | 纯正则，无依赖 |
| `probe-gen.mts` | 无 import | 纯调用 `generateDiffString`（该文件当时内联了逻辑） |
| `probe-rd.mts` / `probe-te.mts` / `probe-ac.mts` / `probe-ac2.mts` / `probe-td-twoslot.mts` | **绝对路径** import（`/home/.../packages/coding-agent/src/...`） | 与 `cwd` 无关 |

> ⚠️ **历史坑（已修）**：`probe-td-twoslot.mts` 初版用**相对 import**（`./src/...`），只能 `cd packages/coding-agent` 后跑；从仓库根跑会 `ERR_MODULE_NOT_FOUND`。**已改为绝对路径**，现两处 `cwd` 都能跑（实测）。
> ⚠️ 绝对路径探针**换机器不可直接跑** —— 需把 `/home/yoshix7ti/projects/pi-rp` 替换成实际仓库根。这是「可复跑」的代价，换取「与 `cwd` 无关」。
> ⚠️ `probe-ac*.mts` / `probe-td-twoslot.mts` 依赖 `/tmp/probe-target.txt`（内容 `甲\n乙\n丙`）作为真 `edit` 的编辑目标；若不存在，先 `cp plan/memory-web/d6-probes/probe-target.txt /tmp/probe-target.txt`。

## 探针 ↔ 断言对应

| 探针 | 支撑的断言（`26-渲染与测试.md`） |
|---|---|
| `probe-diff.mjs` | §10.2 T-E 的反例对照表（`parseDiffLine` 对 `-乙`/`@@` 返回 NULL → 涂灰） |
| `probe-gen.mts` | §10.2「`generateDiffString` × 中文正文」的输出实测（`firstChangedLine: 2`） |
| `probe-rd.mts` | §10.2「`renderDiff` 三色无灰」（`128,128,128` / `204,102,102` / `181,189,104`） |
| `probe-ac.mts` | §10.4「`edit.renderResult` 无视 `argsComplete`」 |
| `probe-ac2.mts` | §10.4「`edit` 在 `argsComplete:false` 下不读盘、不抛」（U6-2 授权的前提） |
| `probe-te.mts` | §10.2 T-E 的 ANSI 字面量（`204;102;102` / `181;189;104` / 灰 `128;128;128`） |
| `probe-td-twoslot.mts` | **§10.1 T-D（P1 判别式）**：memory 形态两槽计数 **2** vs 同输入的真 `edit` 计数 **1** |

**为什么 `probe-td-twoslot.mts` 最关键**：它是 §3.5「不照抄 `edit.ts:232-234`」这条主张的**唯一机械证据**——若实现者写回 `toDraw` 过滤，memory 形态的计数会掉到 1（与 edit 相同），T-D 的 `toBe(2)` 必红。
