/**
 * edit.js — 编辑面板 + 写操作原语 + 危险动作组件（`#/edit` 与 `#/deleted`）。
 *
 * 纯 ESM JavaScript，零依赖，零构建（契约 §2.1）。三条纪律（契约 §9.1）：
 *  1. 本模块**只发 HTTP**，不持有数据库；写操作经契约 §7.1 的 POST 端点，由服务端
 *     `MemoryStore` 承担（修订归档 / 审计 / FTS 重建 / alias 维护）。
 *  2. 读路径不写库：GET 只用于取当前状态（乐观锁复核、diff 基准）。
 *  3. 不伪装模型写入：正文写显式带 `editor_source:"manual"` / `editor_model:null`（§9.2）。
 *
 * 写原语从本文件**具名导出**，供其它视图模块 import（如 `temp.js`、`databases.js`）。
 */

// ⭐ 读写一律走 `app.js` 的 HTTP 层——`?db=` 的唯一真相源在 `app.js`（V7 哨兵盯着本行）。
// ⚠️ ESM 循环依赖（app.js 动态 import 本文件，本文件静态 import 它）是安全的：`get`/`post`
//    是 hoisted 函数声明，且本文件没有任何模块顶层语句调用它们。MUST NOT 新增顶层副作用。
import { get, post } from "../app.js";
import { asyncPage, breadcrumb, choiceModal, confirmModal, dataTable, editorLabel, el, field } from "../ui.js";
import { importanceBadge, lastSegment, shadowedBadge, skeleton, stubChip, uriCopy, uriLine } from "../ui.js";

// 署名渲染统一版落位 ui.js（02 §3.10 对拍收敛）；保留导出名作过渡（下游 import 不破）。
export { editorLabel };

// ── HTTP 出口（形状与旧 `requestJSON` 一致：非 2xx 抛带 `.code`/`.message` 的 Error）──

/** 写路径出口。`query` 槽一并透传（`?db=` 由 HTTP 层注入；既有调用省略它 ⇒ 逐字不变）。 */
export function postJSON(path, body, query) {
	return post(path, body, query);
}

/** 读路径出口。 */
export function getJSON(path, query) {
	return get(path, query);
}

/** 写成功后 MUST 主动广播（契约 §7.4 第②条：服务端自己的写入自己看不见）。 */
function notifyChanged(route, uri) {
	document.dispatchEvent(new CustomEvent("memory:changed", { detail: { route, uri: uri ?? null } }));
}

function currentRoute() {
	const hash = location.hash || "";
	const body = hash.startsWith("#") ? hash.slice(1) : hash;
	const q = body.indexOf("?");
	return q === -1 ? body || "/" : body.slice(0, q);
}

// ── 写操作原语（签名冻结，D5 §10.2） ──────────────────────────────────────────

/** 新建 / 覆盖。服务端 `put` 对同 uri 是 **upsert 覆盖**，不是 conflict（§4.0）。 */
export async function createNode({ uri, content, parent_uri, importance, disclosure, world_ts }) {
	const body = { uri, content };
	if (parent_uri !== undefined) body.parent_uri = parent_uri;
	if (importance !== undefined) body.importance = importance;
	if (disclosure !== undefined) body.disclosure = disclosure;
	if (world_ts !== undefined) body.world_ts = world_ts;
	const res = await postJSON("/api/node", body);
	notifyChanged("/node", uri);
	return res;
}

/**
 * 改正文 / 重要度 / 想起条件 / 节点世界时间。
 * ⭐ 乐观锁：传 `expectedVersion`（数字）时先 `GET /api/node` 复核；不等则**不发写请求**，
 * 返回 `{ ok:false, code:"stale", expected, current, response }` 让调用方弹三选（§6.2）；
 * 传 `expectedVersion: undefined`（就地控件）则跳过复核。
 * ⭐ `version === 0` 是**合法成功**（stub 提升 / 非正文改动，契约 §16.10b）；
 * 只有 `conflict`(409) / `bad_request`(400) 才是失败。
 */
export async function reviseNode({ uri, content, importance, disclosure, world_ts, expectedVersion, wasStub }) {
	if (content !== undefined && content === "") {
		throw writeError("bad_request", "正文不能为空；如需移除整条记忆，请用「删除」。");
	}
	if (importance !== undefined && (!Number.isInteger(importance) || importance < 0 || importance > 10)) {
		throw writeError("bad_request", `重要度必须是 0–10 的整数，收到 ${String(importance)}`);
	}

	if (typeof expectedVersion === "number") {
		const fresh = await getJSON("/api/node", { uri });
		const current = readCurrentVersion(fresh);
		if (current !== null && current !== expectedVersion) {
			return { ok: false, code: "stale", expected: expectedVersion, current, response: fresh };
		}
	}

	const body = { uri };
	if (content !== undefined) {
		body.content = content;
		// §9.2 冻结：人类经 Web UI 改正文 = editor_source "manual" / editor_model null。
		body.editor_source = "manual";
		body.editor_model = null;
	}
	if (importance !== undefined) body.importance = importance;
	if (disclosure !== undefined) body.disclosure = disclosure;
	if (world_ts !== undefined) body.world_ts = world_ts;

	const res = await postJSON("/api/node/revise", body);
	const version = res && typeof res.version === "number" ? res.version : null;
	notifyChanged("/node", uri);
	const wroteContent = content !== undefined;
	return {
		ok: true,
		version,
		response: res,
		// `wasStub` 由调用方从「打开面板时的节点状态」传入：`version === 0` 的两条成因
		// 无法只从响应区分（提升后 `is_stub` 已是 0）。
		message: describeReviseOutcome(version, res, wasStub, wroteContent),
	};
}

/**
 * 按 §3.3(b) 的三分支给成功文案（`version === 0` **不是错误**）。
 * `>=1` → 归档为 v{N}；`===0` 且本次写了正文 → 占位提升；`===0` 且没写正文 → 内容未变化。
 */
export function describeReviseOutcome(version, response, wasStub, wroteContent) {
	if (typeof version !== "number") return "已保存。";
	if (version >= 1) return `已保存，归档为 v${version}`;
	// `version === 0` 有两条成因（契约 §16.10b），文案必须分开：
	//  · 原为 stub + 本次写了正文 → 提升路径（`promote_stub`，不产修订）
	//  · 其余（正文原样保存 / 只改非正文列）→ 内容未变化
	if (wasStub === true && wroteContent === true) return "占位节点已提升为正式记忆";
	const node = nodeOf(response);
	if (node && (node.is_stub === true || node.is_stub === 1)) return "占位节点已提升为正式记忆";
	return "内容未变化，未产生新版本";
}

/** 删节点（级联）。服务端先 `resolveUri` 判存在，不存在 → `not_found`。 */
export async function forgetNode({ uri }) {
	const res = await postJSON("/api/node/forget", { uri });
	notifyChanged("/tree", uri);
	return res;
}

/** 恢复：`version` 给数字 → 恢复历史版本；不给 → 从修订史恢复已删节点。 */
export async function restore({ uri, version }) {
	const body = { uri };
	if (typeof version === "number") body.version = version;
	const res = await postJSON("/api/node/restore", body);
	notifyChanged("/node", uri);
	return res;
}

/**
 * 批量移动 / 改名。请求体形状唯一 = `{ moves: [{from, to}, …] }`。
 * 引擎原生就是 `relocateMany(moves)`（`store.ts:598`）、契约 §7.1 该行写的是「批量移动」，
 * 故**只发 `{moves}`**，MUST NOT 另发顶层 `from`/`to`（不留兼容 shim）。
 * `from === to` 的条目被引擎静默跳过且不记审计，在客户端先过滤并给出提示。
 */
export async function relocate({ moves }) {
	const list = (moves || []).filter((m) => m && m.from && m.to && m.from !== m.to);
	if (list.length === 0) {
		throw writeError("bad_request", "没有可移动的条目（源与目标相同的会被静默跳过）。");
	}
	const res = await postJSON("/api/node/relocate", { moves: list });
	notifyChanged("/node", list[list.length - 1].to);
	return res;
}

export async function addEdge({ uri, target_uri, kind }) {
	const body = { uri, target_uri };
	if (kind !== undefined) body.kind = kind;
	const res = await postJSON("/api/edge", body);
	notifyChanged("/node", uri);
	return res;
}

export async function addGlossary({ uri, keyword }) {
	const res = await postJSON("/api/glossary", { keyword, uri });
	notifyChanged("/node", uri);
	return res;
}

export async function removeGlossary({ keyword }) {
	const res = await postJSON("/api/glossary/remove", { keyword });
	notifyChanged("/view", null);
	return res;
}

/** 醒来清单：`action ∈ list|set|add|remove`。`list` 是只读（不广播）。 */
export async function awaken({ action, uri, uris }) {
	const body = { action };
	if (uri !== undefined) body.uri = uri;
	if (uris !== undefined) body.uris = uris;
	const res = await postJSON("/api/awaken", body);
	if (action !== "list") notifyChanged("/view", uri ?? null);
	return res;
}

/** 世界钟。相对量（`+1d`）的服务端返回值就是解析后的绝对时间（§9.3 的回显要求）。 */
export async function setWorldTime({ value }) {
	const res = await postJSON("/api/world-time", { value });
	notifyChanged("/view", null);
	return res;
}

// ── 行级 diff（LCS；edit 专属，02 公共层清单不含 diff 函数） ─────────────────

/** 行级 diff。返回元素，供调用方插入。 */
export function showDiff(oldText, newText, label) {
	const a = splitLines(oldText);
	const b = splitLines(newText);
	const ops = diffOps(a, b);
	const box = el("div", { class: "mw-diff" });
	if (label) box.append(el("p", { class: "mw-kv", text: label }));
	const pre = document.createElement("pre");
	for (const op of ops) {
		const sign = op.type === "add" ? "+ " : op.type === "del" ? "- " : "  ";
		pre.append(el("div", { text: sign + op.text, dataset: { kind: op.type } }));
	}
	box.append(pre);
	return box;
}

function splitLines(text) {
	if (text === null || text === undefined || text === "") return [];
	return String(text).replace(/\r\n?/g, "\n").split("\n");
}

function diffOps(a, b) {
	const n = a.length;
	const m = b.length;
	const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i -= 1) {
		for (let j = m - 1; j >= 0; j -= 1) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const ops = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ type: "same", text: a[i] });
			i += 1;
			j += 1;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			ops.push({ type: "del", text: a[i] });
			i += 1;
		} else {
			ops.push({ type: "add", text: b[j] });
			j += 1;
		}
	}
	while (i < n) ops.push({ type: "del", text: a[i++] });
	while (j < m) ops.push({ type: "add", text: b[j++] });
	return ops;
}

// ── 危险动作组件：dialog 骨架全部交 ui modal（F1：×/遮罩/Esc/焦点归还） ──────

/**
 * 删除前的二次确认（契约 §9.3 的三要素硬约束）。
 * 三要素：① 子树规模；② 「修订史会保留」；③ 找回路径 + 「只恢复正文」的如实告知。
 * 语气 MUST NOT 软化。返回 Promise<boolean>。
 */
export async function confirmForget({ uri, subtreeSize, losesMetadata }) {
	const size = typeof subtreeSize === "number" && subtreeSize > 0 ? subtreeSize : 1;
	const body = el("div", null, [
		el("p", { text: `将删除至少 ${size} 条记忆（含子树，深层可能更多）：${uri}` }),
		el("p", { text: "删除会真的物理删掉节点行。修订史会保留——正文可以从『恢复已删记忆』页（/api/revisions?deleted=1）找回。" }),
		el("p", {
			text: "恢复只带回正文：重要度、想起条件、世界时间都会回落默认值，且来源会标为 import。"
				+ (losesMetadata ? "（这条记忆带有这些元数据，它们找不回。）" : ""),
		}),
		el("p", { text: "级联删除的子节点需要逐条恢复，且必须父先子后。" }),
	]);
	return confirmModal({ title: "删除记忆（不可撤销）", body, confirmText: "确认删除", cancelText: "取消", danger: true });
}

/** 通用二次确认（悬空边 / 改挂触发词 / 覆盖 / 新建库等场景）。签名不变的过渡导出。 */
export async function confirmSimple(message, confirmText) {
	return confirmModal({ title: "请确认", message, confirmText: confirmText ?? "继续" });
}

/**
 * 乐观锁冲突三选（§6.2）。返回 `"discard" | "overwrite" | null`（「看差异」是 close:false
 * 侧动作：点击后模态**保持打开**、diff 填进槽内，与旧 confirmStale 的「点了不关」逐字一致）。
 * （旧裸 dialog 版 `confirmStale` 已删；本包装只组内容，骨架全在 ui.choiceModal——02 §8 A7。）
 */
function staleChoiceModal(uri, expected, current, myContent) {
	const diffSlot = el("div");
	return choiceModal({
		title: "版本冲突",
		body: [
			el("p", { text: `该记忆已被外部修改（v${expected} → v${current}）：${uri}` }),
			el("p", { text: `覆盖会把对方的 v${current} 归档为修订（可回退）。` }),
			diffSlot,
		],
		actions: [
			{ id: "discard", label: "放弃我的修改", kind: "secondary" },
			{
				id: "diff",
				label: "看差异",
				kind: "outline",
				close: false,
				onClick: () =>
					diffSlot.replaceChildren(showDiff(myContent, "", "你的本地正文（服务端最新正文不可见时只显示本地）")),
			},
			{ id: "overwrite", label: "覆盖", kind: "primary" },
		],
	});
}

// ── 小工具 ────────────────────────────────────────────────────────────────────

function writeError(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

function readCurrentVersion(response) {
	if (!response) return null;
	if (typeof response.current_version === "number") return response.current_version;
	if (response.node && typeof response.node.current_version === "number") {
		return response.node.current_version;
	}
	return null;
}

/** 从 `NodeResponseDTO`（或裸 `NodeDTO`）里取出节点；取不到返回 null。 */
function nodeOf(response) {
	if (!response || typeof response !== "object") return null;
	if (response.node && typeof response.node === "object") return response.node;
	if (response.uri && response.node_id) return response;
	return null;
}

function versionOf(node) {
	if (!node) return undefined;
	const v = node.current_version;
	return typeof v === "number" ? v : undefined;
}

/** 错误码分流（§4.0）：`conflict`(409) 与 `bad_request`(400) 是仅有的两个写失败入口。 */
function describeWriteError(err) {
	const code = err && err.code ? err.code : "internal";
	const message = err && err.message ? err.message : String(err);
	if (code === "conflict") {
		return {
			type: "error",
			text: `地址被占用或状态冲突：${message}`,
			hint: "地址被占用不等于参数写错——请换一个地址，或先处理占用它的那条记忆。",
		};
	}
	if (code === "bad_request") return { type: "error", text: message, hint: "请修正表单里的输入。" };
	if (code === "not_found") return { type: "error", text: message, hint: "该地址已不存在，可能刚被外部删除。" };
	return { type: "error", text: `${code}：${message}`, hint: "请重试；仍失败请看服务端日志。" };
}

// ── 挂载入口：`#/edit` 编辑器 / `#/deleted` 恢复页 ───────────────────────────

export async function mount(el, params, ctx) {
	const routePath = ctx && ctx.route && ctx.route.path ? ctx.route.path : currentRoute();
	if (routePath === "/deleted") return mountRestorePage(el, params, ctx);
	return mountEditor(el, params, ctx);
}

// ═══ 编辑器（`#/edit?uri=&mode=create|revise&action=forget`）═════════════════
// 旧 905 行巨函的拆解（02 §6）：闭包变量显式化为控制器对象 C
// `C = { state, ctx, host, load, render, toast, navigate }`，事件处理 / 动作 / 渲染
// 全部提升为模块级函数、以 C 为首参。行为逐字保持：委托键 / notice 文案 / 乐观锁三选 / entry-scope。

async function mountEditor(el, params, ctx) {
	const C = {
		state: editorState(params),
		ctx,
		host: el,
		load: () => editorLoad(C),
		render: () => editorRender(C),
		toast: ctx.toast,
		navigate: ctx.navigate,
	};
	const ac = new AbortController();
	const { signal } = ac;
	C.host.addEventListener("click", (ev) => editorClick(C, ev), { signal });
	C.host.addEventListener("change", (ev) => editorChange(C, ev), { signal });
	C.host.addEventListener("submit", (ev) => editorSubmit(C, ev), { signal });

	await C.load();
	// D3 的 TEMP 页会跳 `#/edit?uri=…&action=forget`（U-D3-2 采纳），进页即弹高危确认。
	if (C.state.wantForget && nodeOf(C.state.dto)) await runForget(C);
	return function dispose() {
		ac.abort();
		clearTimeout(C.state.debounceTimer);
	};
}

/** 编辑器状态（`state.uri` 是哈希进来的入口地址，`node.uri` 才是规范地址——两者语义不同）。 */
function editorState(params) {
	// `params` 来自壳的 parseHash：恒为 URLSearchParams；typeof 守卫只防手搓调用。
	const P = (k) => (params && typeof params.get === "function" ? params.get(k) ?? "" : "");
	return {
		uri: P("uri"),
		wantForget: P("action") === "forget",
		creating: P("mode") === "create" || P("uri") === "",
		dto: null,
		loading: true,
		error: null,
		busy: false,
		notice: null,
		debounceTimer: null,
	};
}

/** 取数三态：creating 直通；错误 → describeWriteError 进 state.error（未找到卡渲染）。 */
async function editorLoad(C) {
	const st = C.state;
	st.loading = true;
	st.error = null;
	C.render();
	if (st.creating) {
		st.dto = null;
		st.loading = false;
		C.render();
		return;
	}
	try {
		st.dto = await getJSON("/api/node", { uri: st.uri });
	} catch (err) {
		st.dto = null;
		st.error = describeWriteError(err);
	} finally {
		st.loading = false;
		C.render();
	}
}

/** data-action → 动作。需要 target 的（版本号 / keyword）在此解包。 */
const EDITOR_ACTIONS = {
	create: (C) => runCreate(C),
	"save-content": (C) => runSaveContent(C),
	"save-meta": (C) => runSaveMeta(C),
	forget: (C) => runForget(C),
	"restore-rev": (C, t) => runRestoreRevision(C, Number(t.getAttribute("data-version"))),
	"diff-rev": (C, t) => showRevisionDiff(C, Number(t.getAttribute("data-version"))),
	relocate: (C) => runRelocate(C),
	"add-edge": (C) => runAddEdge(C),
	"add-glossary": (C) => runAddGlossary(C),
	"remove-glossary": (C, t) => runRemoveGlossary(C, t.getAttribute("data-keyword")),
	"awaken-add": (C) => runAwakenAdd(C),
	"set-world-time": (C) => runSetWorldTime(C),
	reload: async (C) => C.load(),
};

/** data-form → 提交动作（与 onSubmit 的分发一致）。 */
const FORM_RUNNERS = {
	content: (C) => runSaveContent(C),
	meta: (C) => runSaveMeta(C),
	relocate: (C) => runRelocate(C),
	glossary: (C) => runAddGlossary(C),
	edge: (C) => runAddEdge(C),
	"world-time": (C) => runSetWorldTime(C),
};

async function editorClick(C, ev) {
	const target = ev.target instanceof Element ? ev.target.closest("[data-action]") : null;
	if (!target) return;
	const action = target.getAttribute("data-action");
	ev.preventDefault();
	if (C.state.busy) return;
	if (action === "dismiss-notice") {
		C.state.notice = null;
		C.render();
		return;
	}
	const run = EDITOR_ACTIONS[action];
	if (run) await run(C, target);
}

function editorChange(C, ev) {
	const target = ev.target;
	if (!(target instanceof HTMLInputElement)) return;
	if (target.getAttribute("data-field") !== "importance") return;
	// 就地控件（§4.3 / §6.4）：防抖 400ms 后提交，不复核版本；同一节点同时只有一个在途写。
	const value = Number(target.value);
	if (!Number.isInteger(value) || value < 0 || value > 10) {
		C.toast("重要度必须是 0–10 的整数", "error");
		return;
	}
	clearTimeout(C.state.debounceTimer);
	C.state.debounceTimer = setTimeout(() => {
		void submitImportance(C, value);
	}, 400);
}

function editorSubmit(C, ev) {
	ev.preventDefault();
	if (C.state.busy) return;
	const form = ev.target;
	const action = form && form.getAttribute ? form.getAttribute("data-form") : null;
	const run = FORM_RUNNERS[action];
	if (run) void run(C);
}

/** 读字段（trim）；取不到 / 非字符串 → ""（与旧 field() 逐字一致）。 */
function editorField(host, name) {
	const node = host.querySelector(`[data-field=${name}]`);
	return node && typeof node.value === "string" ? node.value.trim() : "";
}

/**
 * 写动作统一管线：busy 置位 → 渲染 → 执行 → 失败时 notice（reload=true 再拉一次）
 * → busy 复位 → 渲染。catch 内的 `await C.load()` 期间 busy 保持 true（与旧
 * withBusy + try/catch 的时序逐字一致）。
 */
async function guard(C, fn, reload) {
	C.state.busy = true;
	C.render();
	try {
		await fn();
	} catch (err) {
		C.state.notice = describeWriteError(err);
		if (reload) await C.load();
	} finally {
		C.state.busy = false;
		C.render();
	}
}

async function runCreate(C) {
	const uri = editorField(C.host, "create-uri");
	const content = editorField(C.host, "create-content");
	const importance = editorField(C.host, "create-importance");
	if (!uri || uri.indexOf("://") === -1) return fail(C, "地址必须形如 core://a/b（含 ://）。");
	if (/\s/.test(uri)) return fail(C, "地址不能含空白字符。");
	await guard(C, async () => {
		// ⭐ 覆盖保护（§4.1）：服务端 `put` 是 upsert 覆盖，**不会**拒绝；这里是唯一防线。
		const existing = await getJSON("/api/node", { uri }).catch(() => null);
		const node = nodeOf(existing);
		if (node && node.is_stub !== true && node.is_stub !== 1) {
			const ok = await confirmSimple(`${uri} 已存在，继续将覆盖其正文（旧正文会归档为修订）。要继续吗？`, "覆盖");
			if (!ok) return;
		}
		const body = { uri, content };
		if (importance !== "") body.importance = Number(importance);
		await createNode(body);
		C.toast(`已创建：${uri}`, "info");
		C.navigate(`#/node?uri=${encodeURIComponent(uri)}`);
	});
}

async function runSaveContent(C) {
	const st = C.state;
	const node = nodeOf(st.dto);
	if (!node) return;
	const content = editorField(C.host, "content");
	if (content === "") return fail(C, "正文不能为空——空正文会让这条记忆再也搜不到。如需移除整条记忆，请用「删除」。");
	await guard(
		C,
		async () => {
			const res = await reviseNode({ uri: node.uri, content, expectedVersion: versionOf(node), wasStub: node.is_stub === true || node.is_stub === 1 });
			if (res.ok === false && res.code === "stale") {
				const choice = await staleChoiceModal(node.uri, res.expected, res.current, content);
				if (choice === "discard") {
					note(C, "已放弃本次修改，面板重载为外部最新内容。");
					await C.load();
					return;
				}
				if (choice === "diff") {
					note(C, "已保留你的修改，请核对差异后再提交。");
					C.render();
					return;
				}
				if (choice === "overwrite") {
					const forced = await reviseNode({ uri: node.uri, content, wasStub: node.is_stub === true || node.is_stub === 1 });
					note(C, `${forced.message}（对方的 v${res.current} 已归档为修订，可回退）`);
					await C.load();
					return;
				}
				return;
			}
			note(C, res.message);
			C.toast(res.message, "info");
			await C.load();
		},
		true,
	);
}

/**
 * 想起条件 / 节点世界时间：空输入 → **显式 null**（清除），不是空串（§4.4）。
 *
 * ⭐ `uri` MUST be `state.uri`（哈希进来的地址），**不是** `node.uri`（规范地址）。
 *    服务端按 `resolveEntry(uri)` 的结构层写入：命中别名 → `aliases.disclosure`，
 *    否则 → `nodes.disclosure`。发 `node.uri` 会让「从别名入口编辑」静默改到规范入口，
 *    从而覆盖所有入口共享的那一列（契约 T4+T5 组合）。
 *    ⚠️ 同源要求：表单初值（`node.disclosure`）也来自 `load()` 的 `state.uri` ⇒ 读写同作用域。
 */
async function runSaveMeta(C) {
	const st = C.state;
	const node = nodeOf(st.dto);
	if (!node) return;
	const disclosure = editorField(C.host, "disclosure");
	const world_ts = editorField(C.host, "world-ts");
	await guard(C, async () => {
		const res = await reviseNode({
			uri: st.uri,
			disclosure: disclosure === "" ? null : disclosure,
			world_ts: world_ts === "" ? null : world_ts,
		});
		note(C, res.message);
		await C.load();
	});
}

async function submitImportance(C, value) {
	const st = C.state;
	const node = nodeOf(st.dto);
	if (!node) return;
	try {
		// I2 保证不产生修订，也不需版本比对；失败时从服务端重拉（不信任本地值）。
		await reviseNode({ uri: node.uri, importance: value });
		if (st.dto && st.dto.node) st.dto.node.importance = value;
	} catch (err) {
		C.toast(describeWriteError(err).text, "error");
		await C.load();
	}
}

async function runForget(C) {
	const st = C.state;
	const node = nodeOf(st.dto);
	if (!node) return;
	await guard(C, async () => {
		const subtreeSize = await countSubtreeSize(node.uri, C.ctx);
		const ok = await confirmForget({
			uri: node.uri,
			subtreeSize,
			losesMetadata: Boolean(node.disclosure) || Number(node.importance) !== 5 || Boolean(node.world_ts),
		});
		if (!ok) {
			note(C, "已取消删除。");
			return;
		}
		await forgetNode({ uri: node.uri });
		C.toast(`已删除 ${subtreeSize} 条记忆，可在『恢复已删』页找回`, "info");
		st.uri = "";
		C.navigate("#/tree");
	});
}

async function runRestoreRevision(C, version) {
	const st = C.state;
	const node = nodeOf(st.dto);
	if (!node || !Number.isFinite(version)) return;
	const revisions = Array.isArray(st.dto.revisions) ? st.dto.revisions : [];
	const target = revisions.find((r) => r.version === version);
	await guard(
		C,
		async () => {
			if (target) {
				// 契约 §9.3：恢复旧版 MUST 先显示将被覆盖的当前内容 diff。
				const slot = C.host.querySelector("[data-slot=diff]");
				if (slot) slot.replaceChildren(showDiff(node.content, target.content, `当前正文 → v${version}`));
				const ok = await confirmSimple(`恢复 v${version} 会覆盖当前正文（当前正文将归档为新版本，仍可回退）。要继续吗？`, "恢复");
				if (!ok) {
					note(C, "已取消恢复。");
					return;
				}
			}
			await restore({ uri: node.uri, version });
			C.toast(`已恢复到 v${version}`, "info");
			await C.load();
		},
		true,
	);
}

function showRevisionDiff(C, version) {
	const node = nodeOf(C.state.dto);
	if (!node || !Number.isFinite(version)) return;
	const target = (C.state.dto.revisions || []).find((r) => r.version === version);
	if (!target) return;
	const slot = C.host.querySelector("[data-slot=diff]");
	if (!slot) return;
	slot.replaceChildren(showDiff(node.content, target.content, `当前正文（- 为当前） → v${version}（+ 为该版）`));
}

async function runRelocate(C) {
	const st = C.state;
	const node = nodeOf(st.dto);
	if (!node) return;
	const to = editorField(C.host, "relocate-to");
	if (!to) return fail(C, "请填写目标地址。");
	if (to === node.uri) return fail(C, "源与目标相同，这项移动会被静默跳过、不记审计。");
	// ⭐ 阻塞式警告（P1/P15）：不勾选不得提交。
	const ack = C.host.querySelector("[data-field=relocate-ack]");
	if (!ack || !ack.checked) return fail(C, "请先勾选下方的确认项（关联边将不再显示）。");
	await guard(C, async () => {
		const size = await countSubtreeSize(node.uri, C.ctx);
		await relocate({ moves: [{ from: node.uri, to }] });
		C.toast(`已移动 ${size} 个节点：${node.uri} → ${to}`, "info");
		st.uri = to;
		await C.load();
	});
}

async function runAddEdge(C) {
	const node = nodeOf(C.state.dto);
	if (!node) return;
	const target_uri = editorField(C.host, "edge-target");
	const kind = editorField(C.host, "edge-kind");
	if (!target_uri) return fail(C, "请填写目标地址。");
	await guard(C, async () => {
		// P4：store 不校验目标存在，边会悬空 → 前端必须先校验一次。
		const existing = await getJSON("/api/node", { uri: target_uri }).catch(() => null);
		if (!nodeOf(existing)) {
			const ok = await confirmSimple(`目标 ${target_uri} 不存在，边将悬空显示（界面上标为不可点）。要继续吗？`, "仍然保存");
			if (!ok) return;
		}
		await addEdge({ uri: node.uri, target_uri, kind: kind === "" ? undefined : kind });
		C.toast("已保存关联", "info");
		await C.load();
	});
}

async function runAddGlossary(C) {
	const node = nodeOf(C.state.dto);
	if (!node) return;
	const keyword = editorField(C.host, "glossary-keyword");
	if (!keyword) return fail(C, "请填写触发词。");
	await guard(C, async () => {
		// ⭐ 改挂保护：`glossary.keyword` 是主键，被别的节点占用时 store **静默改挂**。
		const index = await C.ctx.api.view({ name: "glossary" }).catch(() => null);
		const owner = index && Array.isArray(index.items) ? index.items.find((g) => g.keyword === keyword) : null;
		if (owner && owner.uri && owner.uri !== node.uri) {
			const ok = await confirmSimple(`触发词「${keyword}」已挂在 ${owner.uri}，继续将改挂到 ${node.uri}。`, "改挂");
			if (!ok) return;
		}
		await addGlossary({ uri: node.uri, keyword });
		C.toast(`已添加触发词：${keyword}（该词现在可用于召回此记忆）`, "info");
		await C.load();
	});
}

async function runRemoveGlossary(C, keyword) {
	if (!keyword) return;
	await guard(C, async () => {
		await removeGlossary({ keyword });
		C.toast(`已移除触发词：${keyword}`, "info");
		await C.load();
	});
}

async function runAwakenAdd(C) {
	const st = C.state;
	const node = nodeOf(st.dto);
	if (!node) return;
	await guard(C, async () => {
		// store 不校验 URI 是否存在（也不校验 stub）→ 这里以节点页正在展示的存活节点为准。
		const list = await awaken({ action: "list" });
		const current = Array.isArray(list && list.uris) ? list.uris.slice() : [];
		if (!current.includes(node.uri)) current.push(node.uri);
		await awaken({ action: "set", uris: current });
		C.toast(`醒来记忆现有 ${current.length} 条`, "info");
	});
}

async function runSetWorldTime(C) {
	const raw = editorField(C.host, "world-time-input");
	if (!raw) return fail(C, "请填写时间（ISO、YYYY-MM-DD，或 +1d / -2h 这样的相对量）。");
	await guard(C, async () => {
		const info = await C.ctx.api.meta({}).catch(() => null);
		const base = info && info.world_time ? String(info.world_time) : null;
		if (/^[+-]/.test(raw) && !base) {
			const ok = await confirmSimple("世界钟尚未设置，相对位移将基于真实系统时间（不是故事时间）。要继续吗？", "继续");
			if (!ok) return;
		}
		const res = await setWorldTime({ value: raw });
		const absolute = res && res.world_time ? String(res.world_time) : raw;
		note(C, `世界钟已设为 ${absolute}${base ? `（原为 ${base}）` : ""}`);
		C.toast(`世界钟：${absolute}`, "info");
	});
}

// ── 编辑器渲染（纯展示，零 I/O） ─────────────────────────────────────────────

function editorRender(C) {
	const st = C.state;
	if (st.creating) {
		C.host.replaceChildren(el("section", { class: "mw-edit" }, [noticeBar(st), renderCreateForm(C)]));
		return;
	}
	if (st.loading) {
		C.host.replaceChildren(skeleton());
		return;
	}
	const node = nodeOf(st.dto);
	if (!node) {
		// 「未找到」分支带自家文案（describeWriteError 的 text/hint），保留 custom 卡。
		const info = st.error || { text: `未找到：${st.uri}` };
		C.host.replaceChildren(
			el("section", { class: "mw-edit" }, [
				el("article", null, [
					el("header", { text: "无法编辑该记忆" }),
					el("p", { text: info.text }),
					info.hint ? el("p", { class: "mw-muted", text: info.hint }) : null,
					el("button", { type: "button", dataset: { action: "reload" }, text: "重试" }),
				]),
			]),
		);
		return;
	}
	C.host.replaceChildren(
		el("section", { class: "mw-edit" }, [
			noticeBar(st),
			renderContentForm(C, node),
			renderMetaBlock(C, node),
			renderRevisions(C, node),
			renderDanger(C),
			renderRelocate(C, node),
			renderEdges(C, node),
			renderGlossary(C),
			renderAwaken(C, node),
			renderWorldTime(C),
		]),
	);
}

/** 编辑器/恢复页共用的 notice 条（知道了按钮；dataset.kind 记级别）。 */
function noticeBar(state) {
	const n = state.notice;
	if (!n) return null;
	return el("article", { dataset: { kind: n.type || "info" }, role: "status" }, [
		el("p", { text: n.text }),
		n.hint ? el("p", { class: "mw-muted", text: n.hint }) : null,
		el("button", { type: "button", class: "mw-btn--outline", dataset: { action: "dismiss-notice" }, text: "知道了" }),
	]);
}

/** 校验失败 → 错误 notice + 渲染；调用方 `return fail(C, …)`。 */
function fail(C, text) {
	C.state.notice = { type: "error", text };
	C.render();
}

/** 提示性 notice（info）。渲染时机由调用方决定（随后的 render/load/guard-finally）。 */
function note(C, text) {
	C.state.notice = { type: "info", text };
}

function renderCreateForm(C) {
	return el("article", null, [
		el("header", { text: "新建记忆" }),
		el("p", { class: "mw-muted", text: "地址形如 core://identity/habits。若该地址已存在，会覆盖其正文（旧正文归档为修订）。" }),
		field({ label: "地址 uri", name: "create-uri", placeholder: "core://a/b" }).root,
		field({ label: "正文", name: "create-content", type: "textarea", rows: 6 }).root,
		field({ label: "重要度（0–10，数值越大越重要；5 = 普通）", name: "create-importance", type: "number", min: 0, max: 10, value: 5 }).root,
		el("button", { type: "button", dataset: { action: "create" }, disabled: C.state.busy, text: "创建" }),
	]);
}

function renderContentForm(C, node) {
	const st = C.state;
	const current = versionOf(node);
	const isStub = node.is_stub === true || node.is_stub === 1;
	return el("article", null, [
		breadcrumbFor(node, st.dto),
		el("header", null, [
			uriLine(node.uri, { full: true }),
			" ",
			el("span", { class: "mw-muted", text: `当前 v${current === undefined ? 0 : current}` }),
			// ⭐ 从别名入口打开时（`state.uri !== node.uri`），页头 MUST 显示**入口**：
			//    否则用户以为在编辑节点本体，实际改的是别名层的条件（D5 §6.4）。
			st.uri && st.uri !== node.uri
				? el("span", { class: "mw-chip", title: "你从旧地址进来；想起条件会写到该入口，不动规范入口" }, ["入口：", uriLine(st.uri)])
				: null,
			isStub ? stubChip() : null,
			node.shadowed === true ? shadowedBadge() : null,
		]),
		el("form", { dataset: { form: "content" } }, [
			field({ label: "正文", name: "content", type: "textarea", rows: 10, value: node.content || "" }).root,
			el("button", { type: "submit", dataset: { action: "save-content" }, disabled: st.busy, text: "保存正文" }),
		]),
		el("div", { dataset: { slot: "diff" } }),
	]);
}

function renderMetaBlock(C, node) {
	const st = C.state;
	return el("article", null, [
		el("header", { text: "重要度与元数据" }),
		el("label", null, [
			"重要度（数值越大越重要）",
			importanceBadge(node.importance),
			el("input", { type: "range", min: "0", max: "10", step: "1", value: String(Number(node.importance)), dataset: { field: "importance" } }),
		]),
		el("p", { class: "mw-muted", text: "刻度：10 = 最重要 · 5 = 普通 · 0 = 边角料。改动就地提交（防抖 400ms），不产生修订。" }),
		el("dl", { class: "mw-kv" }, [
			el("dt", { text: "domain" }), el("dd", { text: node.domain }),
			el("dt", { text: "source" }), el("dd", { text: node.source }),
			el("dt", { text: "created_at" }), el("dd", { text: node.created_at }),
			el("dt", { text: "updated_ts" }), el("dd", { text: node.updated_ts }),
			el("dt", { text: "parent_uri" }),
			el("dd", { text: node.parent_uri === null ? "（根节点）" : node.parent_uri }),
		]),
		// ⭐ entryHint：说明这次编辑落在**哪个入口**上。规范入口与别名入口的写入层不同
		//    （`nodes.disclosure` vs `aliases.disclosure`），`state.uri` 才是真相。
		el("p", { class: "mw-muted", text: entryHint(st, node) }),
		el("form", { dataset: { form: "meta" } }, [
			field({ label: `想起条件 disclosure（当前入口 ${st.uri}；留空 = 清除该入口的条件）`, name: "disclosure", value: node.disclosure === null ? "" : node.disclosure }).root,
			field({ label: "节点世界时间 world_ts（留空 = 清除；与全局世界钟不是一回事）", name: "world-ts", value: node.world_ts === null ? "" : node.world_ts }).root,
			el("button", { type: "submit", dataset: { action: "save-meta" }, disabled: st.busy, text: "保存条件与时间" }),
		]),
	]);
}

function renderRevisions(C, node) {
	const revs = Array.isArray(C.state.dto.revisions) ? C.state.dto.revisions.slice().reverse() : [];
	const busy = C.state.busy;
	return el("article", null, [
		el("header", { text: `修订史（${revs.length}）` }),
		revs.length === 0
			? el("p", { class: "mw-muted", text: "还没有修订——这条记忆从未改过正文。" })
			: dataTable({
					headers: ["版本", "时间", "署名", "归档地址", ""],
					rows: revs.map((r) => [
						`v${r.version}`,
						r.created_at === null || r.created_at === undefined ? "—" : String(r.created_at).slice(0, 19).replace("T", " "),
						labelOf(r),
						r.uri === null || r.uri === undefined ? "—" : uriCopy(r.uri),
						revisionActions(r, busy),
					]),
				}),
		el("p", { class: "mw-muted", text: `归档地址可能与当前地址不同——那是这条记忆改名前的旧地址（relocate 不改写历史修订）。当前地址：${node.uri}` }),
	]);
}

/** 修订行操作格（dataTable 的 cell 必须是单个 Node → 打包成 DocumentFragment）。 */
function revisionActions(r, busy) {
	const frag = document.createDocumentFragment();
	frag.append(
		el("button", { type: "button", class: "mw-btn--outline", dataset: { action: "diff-rev", version: String(r.version) }, text: "看差异" }),
		document.createTextNode(" "),
		el("button", { type: "button", class: "mw-btn--outline", dataset: { action: "restore-rev", version: String(r.version) }, disabled: busy, text: "恢复此版" }),
	);
	return frag;
}

function renderDanger(C) {
	return el("article", null, [
		el("header", { text: "删除这条记忆" }),
		el("p", {
			class: "mw-muted",
			text: "删除会物理删掉节点行，级联删除子树。修订史会保留，正文可从『恢复已删记忆』页找回；重要度 / 想起条件 / 世界时间找不回。",
		}),
		el("button", { type: "button", dataset: { action: "forget" }, disabled: C.state.busy, text: "删除…" }),
	]);
}

function renderRelocate(C, node) {
	const edges = C.state.dto.edges || {};
	const incoming = Array.isArray(edges.incoming) ? edges.incoming : [];
	const dangling = incoming.filter((e) => e.dangling === true).length;
	return el("article", null, [
		el("header", { text: "移动 / 改名" }),
		el("p", {
			class: "mw-muted",
			text: `旧地址 ${node.uri} 会保留为 alias，旧地址仍可解析（这不是缺陷，是设计）。`,
		}),
		el("p", {
			text: `⚠ 移动后，其它记忆指向「${node.uri}」的关联边将不再显示`
				+ "（已知引擎缺陷：relocate 不更新边的目标地址。数据不会丢，但界面上看不到）。"
				+ `受影响：${incoming.length} 条边${dangling > 0 ? `（其中 ${dangling} 条已是悬空边）` : ""}。`
				+ "修复办法 = 移动后对受影响的目标重新「保存关联」。",
		}),
		el("form", { dataset: { form: "relocate" } }, [
			field({ label: "目标地址", name: "relocate-to", placeholder: "core://new/place" }).root,
			el("label", { class: "mw-muted" }, [
				el("input", { type: "checkbox", dataset: { field: "relocate-ack" } }),
				" 我明白，并会在移动后重新保存这些关联",
			]),
			el("button", { type: "submit", dataset: { action: "relocate" }, disabled: C.state.busy, text: "移动" }),
		]),
	]);
}

function renderEdges(C, node) {
	const edges = C.state.dto.edges || { outgoing: [], incoming: [] };
	const list = (edges.outgoing || []).concat(edges.incoming || []);
	return el("article", null, [
		el("header", { text: "关联边" }),
		list.length === 0
			? el("p", { class: "mw-muted", text: "没有关联边。" })
			: el(
					"ul",
					{ class: "mw-row-list" },
					list.map((e) => {
						// ⭐ EdgeDTO.node_id 是「边的源」不是对端；渲染用 uri / resolved_uri。
						const peer = e.uri !== undefined && e.uri !== null ? e.uri : e.resolved_uri;
						return el("li", { class: e.dangling === true ? "mw-edge mw-edge--dangling" : "mw-edge" }, [
							el("span", { class: "mw-chip", text: e.direction === "incoming" ? "指向本节点" : "本节点指向" }),
							" ",
							e.dangling === true || !peer
								? el("span", { class: "mw-muted", text: "⚠ 悬空边（目标不存在）" })
								: uriLine(peer, { href: `#/node?uri=${encodeURIComponent(peer)}` }),
							e.kind ? el("span", { class: "mw-muted", text: ` · ${e.kind}` }) : null,
						]);
					}),
				),
		el("p", { class: "mw-muted", text: "同一对 (本节点, 目标) 重复保存会覆盖原边的 kind——所以这个按钮的语义是「设置关联」。契约没有删边端点，删边请删源节点。" }),
		el("form", { dataset: { form: "edge" } }, [
			field({ label: "目标地址", name: "edge-target", placeholder: "core://other" }).root,
			field({ label: "kind（可选）", name: "edge-kind" }).root,
			el("button", { type: "submit", dataset: { action: "add-edge" }, disabled: C.state.busy, text: "保存关联" }),
		]),
	]);
}

function renderGlossary(C) {
	const items = Array.isArray(C.state.dto.glossary) ? C.state.dto.glossary : [];
	return el("article", null, [
		el("header", { text: "触发词（glossary）" }),
		items.length === 0
			? el("p", { class: "mw-muted", text: "还没有触发词。" })
			: el(
					"ul",
					{ class: "mw-row-list" },
					items.map((g) =>
						el("li", { class: "mw-row" }, [
							el("code", { text: g.keyword }),
							" ",
							el("button", { type: "button", class: "mw-btn--outline", dataset: { action: "remove-glossary", keyword: g.keyword }, disabled: C.state.busy, text: "移除" }),
						]),
					),
				),
		el("p", { class: "mw-muted", text: "触发词会进全文检索——挂着它的记忆，正文没有该词也可能被召回。" }),
		el("form", { dataset: { form: "glossary" } }, [
			field({ label: "新增触发词", name: "glossary-keyword" }).root,
			el("button", { type: "submit", dataset: { action: "add-glossary" }, disabled: C.state.busy, text: "添加" }),
		]),
		el("p", { class: "mw-muted", text: "注意：触发词是主键，同一个触发词只能挂在一个节点上。" }),
	]);
}

function renderAwaken(C, node) {
	return el("article", null, [
		el("header", { text: "醒来清单" }),
		el("p", { class: "mw-muted", text: `把 ${node.uri} 加入醒来清单（先读当前清单，去重追加）。` }),
		el("button", { type: "button", dataset: { action: "awaken-add" }, disabled: C.state.busy, text: "加入醒来清单" }),
		el("p", { class: "mw-muted", text: "醒来清单写入不记审计——审计页不会变化，这是预期行为。" }),
	]);
}

function renderWorldTime(C) {
	return el("article", null, [
		el("header", { text: "世界钟（全局）" }),
		el("p", { class: "mw-muted", text: "世界钟是全局单一故事时间轴，与「节点世界时间」不是一回事：改节点的 world_ts 不动世界钟。" }),
		el("form", { dataset: { form: "world-time" } }, [
			field({ label: "设为（ISO / YYYY-MM-DD / +1d / -2h）", name: "world-time-input", placeholder: "+1d" }).root,
			el("button", { type: "submit", dataset: { action: "set-world-time" }, disabled: C.state.busy, text: "设置世界钟" }),
		]),
	]);
}

/**
 * F7 面包屑。数据源 = `dto.path`（服务端 `buildPath`：implicitParentUri 链、根先序、
 * **不含本节点**；与 node.js 同源，遵守「不自己切 /」纪律）。落点按 03 §10.6：根
 * `domain://` → 树视图域层；祖先段 → 树视图对应层；末段 = 当前节点（aria-current + title）。
 */
function breadcrumbFor(node, dto) {
	const path = Array.isArray(dto && dto.path) ? dto.path : [];
	if (path.length === 0 || !path[0] || !path[0].uri) return null;
	const domain = node.domain || String(path[0].uri).split("://")[0] || "";
	const items = [{ label: `${domain}://`, title: `${domain}://`, href: `#/tree?domain=${encodeURIComponent(domain)}` }];
	for (const p of path) {
		items.push({ label: lastSegment(p.uri), title: p.uri, href: `#/tree?uri=${encodeURIComponent(p.uri)}` });
	}
	items.push({ label: lastSegment(node.uri), title: node.uri, current: true });
	return breadcrumb(items);
}

/**
 * ⭐ 这次编辑写的是哪个入口的条件（D5 §3-M4-3）。
 *
 * `state.uri` 是哈希进来的地址；`node.uri` 是它解析到的规范地址。两者不同 = 从别名入口进来。
 * `dto.aliases[].dead === true` 时该入口被同名节点遮蔽，条件不会生效 —— **必须说出来**，
 * 否则用户设了条件、刷新、发现什么都没变（契约 T5 的形态，这次在 UI 侧）。
 */
function entryHint(st, node) {
	const aliases = Array.isArray(st.dto && st.dto.aliases) ? st.dto.aliases : [];
	const entry = aliases.find((a) => a && a.alias_uri === st.uri);
	if (entry) {
		return entry.dead === true
			? `你正在编辑入口 ${st.uri}。此入口被同名节点遮蔽，条件不会生效。`
			: `你正在编辑入口 ${st.uri} 的条件。`;
	}
	if (st.uri && node && st.uri !== node.uri) return `你正在编辑入口 ${st.uri} 的条件。`;
	return `你正在编辑规范入口 ${node ? node.uri : st.uri} 的条件。`;
}

// ═══ 恢复页（`#/deleted`）—— 数据源只有 `/api/revisions?deleted=1` ════════════

/**
 * ⚠️ 本页**不用 `/api/audit` 当数据源**（D5 §8.4）：`delete_node` / `restore_deleted` 是两条
 * 独立事件，靠状态重放推不出「现在哪些 URI 可恢复」。真相来源只有 revision 表。
 * ⭐⭐ 两个陷阱（P14 / §7.3）：1. **按 `node_id` 分组**——relocate 后又被删的节点会以旧/新
 * 两行出现，背后是同一个 `node_id`（`node_revisions.uri` 逐行不同），不分组用户会以为有两份；
 * 2. **默认只对「最新 URI」开放恢复**——从旧 URI 恢复会**静默拿回改名前的旧正文**（不报错、
 * 界面还显示成功），并把 `node_id` 占住，导致从正确地址恢复时报约束错误。
 */
function mountRestorePage(el, params, ctx) {
	const state = { groups: [], busy: false, notice: null };
	const expanded = new Set();
	const ac = new AbortController();
	const C = { ctx, host: el, state, expanded };
	// 数据就绪后的整页重绘（busy / notice / 分组展开变化时由事件侧调用）。
	const pageRoot = () => el("section", { class: "mw-deleted" }, [noticeBar(state), restoreBody(C)]);
	C.render = () => C.host.replaceChildren(pageRoot());
	// 三态（骨架 / 错误卡 / 数据）交给 asyncPage：并发守卫让慢响应覆盖不了新挂载。
	const page = asyncPage(el, {
		load: async () => {
			const body = await ctx.api.revs({ deleted: "1" });
			const items = Array.isArray(body && body.items) ? body.items : [];
			return (state.groups = groupDeleted(items));
		},
		render: pageRoot,
		onError: (err, host) => {
			state.groups = [];
			host.replaceChildren(
				el("section", { class: "mw-deleted" }, [
					el("article", null, [
						el("header", { text: "无法载入已删记忆" }),
						el("p", { text: describeWriteError(err).text }),
						el("button", { type: "button", dataset: { action: "reload" }, text: "重试" }),
					]),
				]),
			);
		},
	});
	C.reload = page.refresh;
	C.host.addEventListener("click", (ev) => restoreClick(C, ev), { signal: ac.signal });
	return function dispose() {
		ac.abort();
		page.dispose();
	};
}

async function restoreClick(C, ev) {
	const target = ev.target instanceof Element ? ev.target.closest("[data-action]") : null;
	if (!target) return;
	const action = target.getAttribute("data-action");
	ev.preventDefault();
	if (action === "toggle-group") {
		const key = target.getAttribute("data-group");
		if (C.expanded.has(key)) C.expanded.delete(key);
		else C.expanded.add(key);
		C.render();
		return;
	}
	if (action === "reload") return void C.reload();
	if (action === "dismiss-notice") {
		C.state.notice = null;
		C.render();
		return;
	}
	if (action === "restore" && !C.state.busy) {
		await runRestore(C, target.getAttribute("data-uri"));
	}
}

async function runRestore(C, uri) {
	await guard(C, async () => {
		const ok = await confirmSimple(
			`将从修订史恢复 ${uri}。只带回正文：重要度 / 想起条件 / 世界时间会回落默认值，`
				+ "来源会标为 import。级联删除的子树要逐条恢复，且必须父先子后（子先恢复会补一个占位父，堵死父的恢复）。要继续吗？",
			"恢复",
		);
		if (!ok) {
			note(C, "已取消恢复。");
			return;
		}
		await restore({ uri });
		C.toast(`已从修订史恢复：${uri}（来源标为 import）`, "info");
		note(C, `已从修订史恢复：${uri}（来源标为 import）。`);
		await C.load();
	});
}

function restoreBody(C) {
	const groups = C.state.groups;
	const head = el("header", null, [
		el("h2", { text: "恢复已删记忆" }),
		el("p", {
			class: "mw-muted",
			text: "删除只删节点行，修订史保留。这里列出所有只剩修订史、没有活节点的地址。恢复按 URI 深度升序排列（父先子后）。",
		}),
		el("p", { class: "mw-muted", text: "备份请直接复制 memory.db 文件——本页不提供导出（契约 §1.3 不做 export 端点）。" }),
	]);
	if (groups.length === 0) {
		return el("div", null, [head, el("p", { class: "mw-muted", text: "没有可恢复的已删记忆。" })]);
	}
	return el("div", null, [head].concat(groups.map((g) => restoreGroupCard(C, g))));
}

function restoreGroupCard(C, g) {
	const open = C.expanded.has(g.key);
	const hiddenRows = g.rows.filter((r) => r !== g.latest);
	const versions = g.rows.reduce((sum, r) => sum + (Number(r.versions) || 0), 0);
	return el("article", { dataset: { uri: g.latest.uri } }, [
		el("header", null, [
			uriLine(g.latest.uri, { full: true }),
			" ",
			el("span", { class: "mw-muted", text: `${versions} 版修订` }),
			g.rows.length > 1 ? el("span", { class: "mw-chip", text: `同一记忆的 ${g.rows.length} 个地址` }) : null,
			g.hasChildrenInList
				? el("span", {
						class: "mw-chip",
						title: "有子节点也在这份列表里；子先恢复会给父补一个占位节点，堵死父的恢复",
						text: "有子节点待恢复",
					})
				: null,
		]),
		el("p", { class: "mw-muted", text: `最后归档：${g.latest.last_seen || "—"}` }),
		el("button", { type: "button", dataset: { action: "restore", uri: g.latest.uri }, disabled: C.state.busy, text: "恢复这一条" }),
		hiddenRows.length > 0 ? restoreHistory(C, g, hiddenRows, open) : null,
	]);
}

function restoreHistory(C, g, hiddenRows, open) {
	return el("details", { open }, [
		el("summary", { dataset: { action: "toggle-group", group: g.key }, text: `${hiddenRows.length} 个历史地址（只读，默认折叠）` }),
		el(
			"ul",
			{ class: "mw-row-list" },
			hiddenRows.map((r) =>
				el("li", { class: "mw-row" }, [
					uriLine(r.uri),
					el("span", { class: "mw-muted", text: `（${Number(r.versions) || 0} 版）` }),
					el("p", {
						class: "mw-muted",
						text: "⚠ 历史地址：从此处恢复会拿回改名前的旧正文（静默，不报错），并占住这条记忆的 node_id，导致从上面的当前地址恢复时报冲突。默认不可点——除非你确实要那一版。",
					}),
				]),
			),
		),
	]);
}

/**
 * 把 `{uri, node_id, versions, last_seen}[]` 按 `node_id` 分组，并标出每组的**最新 URI**
 * （该组里 `last_seen` 最大的那一行；`last_seen` 是 `MAX(created_at)`，同秒归档会有同值歧义，
 * 此时退回保留服务端返回顺序里的第一条）。
 */
export function groupDeleted(items) {
	const byNode = new Map();
	const order = [];
	for (const raw of items || []) {
		const node_id = raw && raw.node_id ? String(raw.node_id) : `uri:${raw && raw.uri ? raw.uri : "?"}`;
		if (!byNode.has(node_id)) {
			byNode.set(node_id, { key: node_id, rows: [] });
			order.push(node_id);
		}
		byNode.get(node_id).rows.push({
			uri: raw && raw.uri ? String(raw.uri) : "",
			versions: raw ? Number(raw.versions) || 0 : 0,
			last_seen: raw && raw.last_seen ? String(raw.last_seen) : "",
		});
	}

	const groups = order.map((key) => {
		const g = byNode.get(key);
		let latest = g.rows[0];
		for (const r of g.rows) {
			if (r.last_seen > latest.last_seen) latest = r;
		}
		return {
			key,
			rows: g.rows,
			latest,
			hasChildrenInList: g.rows.some((r) => order.some((k) => k !== key && byNode.get(k).rows.some((x) => x.uri.startsWith(`${r.uri}/`)))),
		};
	});
	// 父先子后：按 URI 段数（深度）升序。
	groups.sort((a, b) => depthOf(a.latest.uri) - depthOf(b.latest.uri));
	return groups;
}

function depthOf(uri) {
	const s = uri === null || uri === undefined ? "" : String(uri);
	const body = s.indexOf("://") === -1 ? s : s.slice(s.indexOf("://") + 3);
	return body === "" ? 0 : body.split("/").length;
}

/**
 * 子树节点数（含自身），用于删除确认与 relocate 提示。
 * 取数用 `/api/tree?parentUri=&depth=3`（该端点 `depth` 上限就是 3，契约 D1 §7.2），按 uri
 * 前缀计数。更深的层**数不到**——有意的保守降级：宁可少报，不谎报规模；文案说「至少 N 条」。
 * 取数失败时返回 1（即「至少它自己」）。
 */
async function countSubtreeSize(uri, ctx) {
	try {
		const body = await ctx.api.tree({ parentUri: uri, depth: 3 });
		const items = Array.isArray(body && body.items) ? body.items : [];
		let size = 1;
		for (const it of items) {
			if (it && typeof it.uri === "string" && it.uri.startsWith(`${uri}/`)) size += 1;
		}
		return size;
	} catch {
		return 1;
	}
}

function labelOf(rev) {
	const label = editorLabel(rev);
	return label === null ? "（无署名信息）" : label;
}
