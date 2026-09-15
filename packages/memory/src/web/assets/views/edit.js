/**
 * edit.js — 编辑面板 + 写操作原语 + 危险动作组件（`#/edit` 与 `#/deleted`）。
 *
 * 纯 ESM JavaScript，零依赖，零构建（契约 §2.1）。
 *
 * 三条纪律的落地点（契约 §9.1）：
 *  1. 本模块**只发 HTTP**，不持有数据库；所有写操作经契约 §7.1 的 POST 端点，
 *     由服务端 `MemoryStore` 方法承担（修订归档 / 审计 / FTS 重建 / alias 维护）。
 *  2. 读路径不写库：GET 只用于取当前状态（乐观锁复核、diff 基准）。
 *  3. 不伪装模型写入：正文写的请求体显式带 `editor_source:"manual"` / `editor_model:null`（§9.2）。
 *
 * 写原语从本文件**具名导出**，供其它视图模块 import（如 `temp.js`），
 * 避免在两个页面各写一份 HTTP 逻辑。
 */

// ── 唯一碰 fetch 的地方 ──────────────────────────────────────────────────────

/**
 * `postJSON` 是写路径出口，`getJSON` 是读路径出口 —— 全文件只有这一处 `fetch`。
 * 非 2xx 时解析契约 §7.3 的 `{error:{code,message}}` 并抛带 `.code` 的 Error
 * （**MUST NOT** 只抛 status）。**不自动重试**（写操作重试 = 可能重复写）。
 */
async function requestJSON(path, method, payload) {
	const url = new URL(path, location.href);
	url.hash = "";
	url.search = "";
	const init = { method, headers: { Accept: "application/json" } };
	if (method === "GET") {
		for (const k of Object.keys(payload || {})) {
			const v = payload[k];
			if (v === null || v === undefined || v === "") continue;
			url.searchParams.set(k, String(v));
		}
	} else {
		init.headers["Content-Type"] = "application/json";
		init.body = JSON.stringify(payload || {});
	}
	const res = await fetch(url, init);
	let body = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	if (!res.ok) {
		const info = body && body.error ? body.error : null;
		const err = new Error((info && info.message) || `HTTP ${res.status}`);
		err.code = (info && info.code) || "internal";
		err.status = res.status;
		throw err;
	}
	return body;
}

export function postJSON(path, body) {
	return requestJSON(path, "POST", body);
}

export function getJSON(path, query) {
	return requestJSON(path, "GET", query);
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
 *
 * ⭐ 乐观锁：传 `expectedVersion`（数字）时先 `GET /api/node` 复核；不等则**不发写请求**，
 * 返回 `{ ok:false, code:"stale", expected, current, response }` 让调用方弹三选（§6.2）。
 * 传 `expectedVersion: undefined`（就地控件）则跳过复核。
 *
 * ⭐ `version === 0` 是**合法成功**（stub 提升 / 非正文改动，契约 §16.10b）：
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
 *
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

// ── 展示组件（无 API 依赖，可被其它视图模块复用） ─────────────────────────────

/**
 * 署名渲染（契约 §9.2 的**唯一**冻结规则）。
 * `manual` + `editor_model === null` → 「用户（Web UI）」。
 * `null/null` → 「系统」：`restoreRevision` 归档的那一版确实是系统动作（§8.8）。
 * 两个键都缺失 → `null`（没取到，省略整块，不写「未知来源」）。
 */
export function editorLabel(rev) {
	const r = rev || {};
	const hasSource = Object.prototype.hasOwnProperty.call(r, "editor_source");
	const hasModel = Object.prototype.hasOwnProperty.call(r, "editor_model");
	if (!hasSource && !hasModel) return null;
	if (r.editor_model === null && r.editor_source === "manual") return "用户（Web UI）";
	if (r.editor_model) return `By ${r.editor_model}`;
	if (r.editor_source === null || r.editor_source === undefined) return "系统";
	return r.editor_source;
}

/** 行级 diff（LCS）。返回元素，供调用方插入。 */
export function showDiff(oldText, newText, label) {
	const a = splitLines(oldText);
	const b = splitLines(newText);
	const ops = diffOps(a, b);
	const box = document.createElement("div");
	box.className = "mw-diff";
	if (label) {
		const head = document.createElement("p");
		head.className = "mw-kv";
		head.textContent = label;
		box.append(head);
	}
	const pre = document.createElement("pre");
	for (const op of ops) {
		const line = document.createElement("div");
		const sign = op.type === "add" ? "+ " : op.type === "del" ? "- " : "  ";
		line.textContent = sign + op.text;
		line.dataset.kind = op.type;
		pre.append(line);
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

/**
 * 删除前的二次确认（契约 §9.3 的三要素硬约束）。
 * 三要素：① 子树规模；② 「修订史会保留」；③ 找回路径 + 「只恢复正文」的如实告知。
 * 语气 MUST NOT 软化。返回 Promise<boolean>。
 */
export async function confirmForget({ uri, subtreeSize, losesMetadata }) {
	const size = typeof subtreeSize === "number" && subtreeSize > 0 ? subtreeSize : 1;
	const body = document.createElement("div");

	const p1 = document.createElement("p");
	p1.textContent = `将删除至少 ${size} 条记忆（含子树，深层可能更多）：${uri}`;
	body.append(p1);

	const p2 = document.createElement("p");
	p2.textContent =
		"删除会真的物理删掉节点行。修订史会保留——正文可以从『恢复已删记忆』页" +
		"（/api/revisions?deleted=1）找回。";
	body.append(p2);

	const p3 = document.createElement("p");
	p3.textContent =
		"恢复只带回正文：重要度、想起条件、世界时间都会回落默认值，且来源会标为 import。" +
		(losesMetadata ? "（这条记忆带有这些元数据，它们找不回。）" : "");
	body.append(p3);

	const p4 = document.createElement("p");
	p4.textContent = "级联删除的子节点需要逐条恢复，且必须父先子后。";
	body.append(p4);

	return openDialog("删除记忆（不可撤销）", body, "确认删除", "取消");
}

/** 通用二次确认（用于悬空边 / 改挂触发词 / 覆盖等场景）。 */
export async function confirmSimple(message, confirmText) {
	const body = document.createElement("div");
	const p = document.createElement("p");
	p.textContent = message;
	body.append(p);
	return openDialog("请确认", body, confirmText || "继续", "取消");
}

/** 打开一个 `<dialog>` 模态，返回用户是否确认。Esc / 关闭一律视为取消。 */
function openDialog(title, body, okText, cancelText) {
	const dialog = document.createElement("dialog");
	const article = document.createElement("article");

	const head = document.createElement("header");
	const strong = document.createElement("strong");
	strong.textContent = title;
	head.append(strong);

	const footer = document.createElement("footer");
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "secondary";
	cancel.textContent = cancelText || "取消";
	const confirm = document.createElement("button");
	confirm.type = "button";
	confirm.textContent = okText || "确定";
	footer.append(cancel, confirm);

	article.append(head, body, footer);
	dialog.append(article);
	document.body.append(dialog);

	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			cancel.removeEventListener("click", onCancel);
			confirm.removeEventListener("click", onOk);
			dialog.removeEventListener("close", onClose);
			if (dialog.open && typeof dialog.close === "function") dialog.close();
			dialog.remove();
			resolve(value);
		};
		const onCancel = () => done(false);
		const onOk = () => done(true);
		const onClose = () => done(false);
		cancel.addEventListener("click", onCancel);
		confirm.addEventListener("click", onOk);
		dialog.addEventListener("close", onClose);
		if (typeof dialog.showModal === "function") dialog.showModal();
		else dialog.setAttribute("open", "");
	});
}

// ── 小工具 ────────────────────────────────────────────────────────────────────

function writeError(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

function h(tag, props, children) {
	const node = document.createElement(tag);
	const p = props || {};
	for (const key of Object.keys(p)) {
		const v = p[key];
		if (v === null || v === undefined || v === false) continue;
		if (key === "class") node.className = v;
		else if (key === "text") node.textContent = String(v);
		else if (key === "dataset") {
			for (const dk of Object.keys(v)) node.dataset[dk] = String(v[dk]);
		} else node.setAttribute(key, v === true ? "" : String(v));
	}
	const kids = children === null || children === undefined ? [] : [].concat(children);
	for (const c of kids) {
		if (c === null || c === undefined || c === false) continue;
		node.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return node;
}

function paramOf(params) {
	if (params && typeof params.get === "function") return (k) => params.get(k) ?? "";
	const src = params || {};
	return (k) => (src[k] === null || src[k] === undefined ? "" : String(src[k]));
}

function toast(ctx, msg, type) {
	if (ctx && typeof ctx.toast === "function") ctx.toast(msg, type);
	else if (type === "error") console.warn(msg);
}

function navigate(ctx, hash) {
	if (ctx && typeof ctx.navigate === "function") ctx.navigate(hash);
	else location.hash = hash;
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

// ══════════════════════════════════════════════════════════════════════════════
// 编辑器（`#/edit?uri=&mode=create|revise&action=forget`）
// ══════════════════════════════════════════════════════════════════════════════

async function mountEditor(el, params, ctx) {
	const P = paramOf(params);
	const ac = new AbortController();
	const { signal } = ac;

	const state = {
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

	el.addEventListener("click", onClick, { signal });
	el.addEventListener("change", onChange, { signal });
	el.addEventListener("submit", onSubmit, { signal });

	await load();
	// D3 的 TEMP 页会跳 `#/edit?uri=…&action=forget`（U-D3-2 采纳），进页即弹高危确认。
	if (state.wantForget && nodeOf(state.dto)) await runForget();
	return function dispose() {
		ac.abort();
		clearTimeout(state.debounceTimer);
	};

	// ── 取数 ────────────────────────────────────────────────────────────────

	async function load() {
		state.loading = true;
		state.error = null;
		render();
		if (state.creating) {
			state.dto = null;
			state.loading = false;
			render();
			return;
		}
		try {
			state.dto = await getJSON("/api/node", { uri: state.uri });
		} catch (err) {
			state.dto = null;
			state.error = describeWriteError(err);
		} finally {
			state.loading = false;
			render();
		}
	}

	// ── 事件 ────────────────────────────────────────────────────────────────

	async function onClick(ev) {
		const target = ev.target instanceof Element ? ev.target.closest("[data-action]") : null;
		if (!target) return;
		const action = target.getAttribute("data-action");
		ev.preventDefault();
		if (state.busy) return;

		if (action === "create") return void (await runCreate());
		if (action === "save-content") return void (await runSaveContent());
		if (action === "save-meta") return void (await runSaveMeta());
		if (action === "forget") return void (await runForget());
		if (action === "restore-rev") {
			return void (await runRestoreRevision(Number(target.getAttribute("data-version"))));
		}
		if (action === "diff-rev") return void showRevisionDiff(Number(target.getAttribute("data-version")));
		if (action === "relocate") return void (await runRelocate());
		if (action === "add-edge") return void (await runAddEdge());
		if (action === "add-glossary") return void (await runAddGlossary());
		if (action === "remove-glossary") {
			return void (await runRemoveGlossary(target.getAttribute("data-keyword")));
		}
		if (action === "awaken-add") return void (await runAwakenAdd());
		if (action === "set-world-time") return void (await runSetWorldTime());
		if (action === "reload") return void (await load());
		if (action === "dismiss-notice") {
			state.notice = null;
			render();
		}
	}

	function onChange(ev) {
		const target = ev.target;
		if (!(target instanceof HTMLInputElement)) return;
		if (target.getAttribute("data-field") !== "importance") return;
		// 就地控件（§4.3 / §6.4）：防抖 400ms 后提交，不复核版本；同一节点同时只有一个在途写。
		const value = Number(target.value);
		if (!Number.isInteger(value) || value < 0 || value > 10) {
			toast(ctx, "重要度必须是 0–10 的整数", "error");
			return;
		}
		clearTimeout(state.debounceTimer);
		state.debounceTimer = setTimeout(() => {
			void submitImportance(value);
		}, 400);
	}

	function onSubmit(ev) {
		ev.preventDefault();
		if (state.busy) return;
		const form = ev.target;
		const action = form && form.getAttribute ? form.getAttribute("data-form") : null;
		if (action === "content") void runSaveContent();
		else if (action === "meta") void runSaveMeta();
		else if (action === "relocate") void runRelocate();
		else if (action === "glossary") void runAddGlossary();
		else if (action === "edge") void runAddEdge();
		else if (action === "world-time") void runSetWorldTime();
	}

	// ── 写动作 ──────────────────────────────────────────────────────────────

	function field(name) {
		const node = el.querySelector(`[data-field=${name}]`);
		return node && typeof node.value === "string" ? node.value.trim() : "";
	}

	async function withBusy(fn) {
		state.busy = true;
		render();
		try {
			await fn();
		} finally {
			state.busy = false;
			render();
		}
	}

	async function runCreate() {
		const uri = field("create-uri");
		const content = field("create-content");
		const importance = field("create-importance");
		if (!uri || uri.indexOf("://") === -1) {
			state.notice = { type: "error", text: "地址必须形如 core://a/b（含 ://）。" };
			render();
			return;
		}
		if (/\s/.test(uri)) {
			state.notice = { type: "error", text: "地址不能含空白字符。" };
			render();
			return;
		}
		await withBusy(async () => {
			try {
				// ⭐ 覆盖保护（§4.1）：服务端 `put` 是 upsert 覆盖，**不会**拒绝；这里是唯一防线。
				const existing = await getJSON("/api/node", { uri }).catch(() => null);
				const node = nodeOf(existing);
				if (node && node.is_stub !== true && node.is_stub !== 1) {
					const ok = await confirmSimple(
						`${uri} 已存在，继续将覆盖其正文（旧正文会归档为修订）。要继续吗？`,
						"覆盖",
					);
					if (!ok) return;
				}
				const body = { uri, content };
				if (importance !== "") body.importance = Number(importance);
				await createNode(body);
				toast(ctx, `已创建：${uri}`, "info");
				navigate(ctx, `#/node?uri=${encodeURIComponent(uri)}`);
			} catch (err) {
				state.notice = describeWriteError(err);
			}
		});
	}

	async function runSaveContent() {
		const node = nodeOf(state.dto);
		if (!node) return;
		const content = field("content");
		if (content === "") {
			state.notice = {
				type: "error",
				text: "正文不能为空——空正文会让这条记忆再也搜不到。如需移除整条记忆，请用「删除」。",
			};
			render();
			return;
		}
		await withBusy(async () => {
			try {
				const res = await reviseNode({
					uri: node.uri,
					content,
					expectedVersion: versionOf(node),
					wasStub: node.is_stub === true || node.is_stub === 1,
				});
				if (res.ok === false && res.code === "stale") {
					const choice = await confirmStale(node.uri, res.expected, res.current, content);
					if (choice === "discard") {
						state.notice = { type: "info", text: "已放弃本次修改，面板重载为外部最新内容。" };
						await load();
						return;
					}
					if (choice === "diff") {
						state.notice = { type: "info", text: "已保留你的修改，请核对差异后再提交。" };
						render();
						return;
					}
					if (choice === "overwrite") {
						const forced = await reviseNode({ uri: node.uri, content, wasStub: node.is_stub === true || node.is_stub === 1 });
						state.notice = {
							type: "info",
							text: `${forced.message}（对方的 v${res.current} 已归档为修订，可回退）`,
						};
						await load();
						return;
					}
					return;
				}
				state.notice = { type: "info", text: res.message };
				toast(ctx, res.message, "info");
				await load();
			} catch (err) {
				state.notice = describeWriteError(err);
				await load();
			}
		});
	}

	/** 想起条件 / 节点世界时间：空输入 → **显式 null**（清除），不是空串（§4.4）。 */
	async function runSaveMeta() {
		const node = nodeOf(state.dto);
		if (!node) return;
		const disclosure = field("disclosure");
		const world_ts = field("world-ts");
		await withBusy(async () => {
			try {
				const res = await reviseNode({
					uri: node.uri,
					disclosure: disclosure === "" ? null : disclosure,
					world_ts: world_ts === "" ? null : world_ts,
				});
				state.notice = { type: "info", text: res.message };
				await load();
			} catch (err) {
				state.notice = describeWriteError(err);
			}
		});
	}

	async function submitImportance(value) {
		const node = nodeOf(state.dto);
		if (!node) return;
		try {
			// I2 保证不产生修订，也不需版本比对；失败时从服务端重拉（不信任本地值）。
			await reviseNode({ uri: node.uri, importance: value });
			if (state.dto && state.dto.node) state.dto.node.importance = value;
		} catch (err) {
			toast(ctx, describeWriteError(err).text, "error");
			await load();
		}
	}

	async function runForget() {
		const node = nodeOf(state.dto);
		if (!node) return;
		await withBusy(async () => {
			try {
				const subtreeSize = await countSubtreeSize(node.uri, ctx);
				const ok = await confirmForget({
					uri: node.uri,
					subtreeSize,
					losesMetadata:
						Boolean(node.disclosure) || Number(node.importance) !== 5 || Boolean(node.world_ts),
				});
				if (!ok) {
					state.notice = { type: "info", text: "已取消删除。" };
					return;
				}
				await forgetNode({ uri: node.uri });
				toast(ctx, `已删除 ${subtreeSize} 条记忆，可在『恢复已删』页找回`, "info");
				state.uri = "";
				navigate(ctx, "#/tree");
			} catch (err) {
				state.notice = describeWriteError(err);
			}
		});
	}

	async function runRestoreRevision(version) {
		const node = nodeOf(state.dto);
		if (!node || !Number.isFinite(version)) return;
		const revisions = Array.isArray(state.dto.revisions) ? state.dto.revisions : [];
		const target = revisions.find((r) => r.version === version);
		await withBusy(async () => {
			try {
				if (target) {
					// 契约 §9.3：恢复旧版 MUST 先显示将被覆盖的当前内容 diff。
					const slot = el.querySelector("[data-slot=diff]");
					if (slot) slot.replaceChildren(showDiff(node.content, target.content, `当前正文 → v${version}`));
					const ok = await confirmSimple(
						`恢复 v${version} 会覆盖当前正文（当前正文将归档为新版本，仍可回退）。要继续吗？`,
						"恢复",
					);
					if (!ok) {
						state.notice = { type: "info", text: "已取消恢复。" };
						return;
					}
				}
				await restore({ uri: node.uri, version });
				toast(ctx, `已恢复到 v${version}`, "info");
				await load();
			} catch (err) {
				state.notice = describeWriteError(err);
				await load();
			}
		});
	}

	function showRevisionDiff(version) {
		const node = nodeOf(state.dto);
		if (!node || !Number.isFinite(version)) return;
		const target = (state.dto.revisions || []).find((r) => r.version === version);
		if (!target) return;
		const slot = el.querySelector("[data-slot=diff]");
		if (!slot) return;
		slot.replaceChildren(showDiff(node.content, target.content, `当前正文（- 为当前） → v${version}（+ 为该版）`));
	}

	async function runRelocate() {
		const node = nodeOf(state.dto);
		if (!node) return;
		const to = field("relocate-to");
		if (!to) {
			state.notice = { type: "error", text: "请填写目标地址。" };
			render();
			return;
		}
		if (to === node.uri) {
			state.notice = { type: "error", text: "源与目标相同，这项移动会被静默跳过、不记审计。" };
			render();
			return;
		}
		// ⭐ 阻塞式警告（P1/P15）：不勾选不得提交。
		const ack = el.querySelector("[data-field=relocate-ack]");
		if (!ack || !ack.checked) {
			state.notice = { type: "error", text: "请先勾选下方的确认项（关联边将不再显示）。" };
			render();
			return;
		}
		await withBusy(async () => {
			try {
				const size = await countSubtreeSize(node.uri, ctx);
				await relocate({ moves: [{ from: node.uri, to }] });
				toast(ctx, `已移动 ${size} 个节点：${node.uri} → ${to}`, "info");
				state.uri = to;
				await load();
			} catch (err) {
				state.notice = describeWriteError(err);
			}
		});
	}

	async function runAddEdge() {
		const node = nodeOf(state.dto);
		if (!node) return;
		const target_uri = field("edge-target");
		const kind = field("edge-kind");
		if (!target_uri) {
			state.notice = { type: "error", text: "请填写目标地址。" };
			render();
			return;
		}
		await withBusy(async () => {
			try {
				// P4：store 不校验目标存在，边会悬空 → 前端必须先校验一次。
				const existing = await getJSON("/api/node", { uri: target_uri }).catch(() => null);
				if (!nodeOf(existing)) {
					const ok = await confirmSimple(
						`目标 ${target_uri} 不存在，边将悬空显示（界面上标为不可点）。要继续吗？`,
						"仍然保存",
					);
					if (!ok) return;
				}
				await addEdge({ uri: node.uri, target_uri, kind: kind === "" ? undefined : kind });
				toast(ctx, "已保存关联", "info");
				await load();
			} catch (err) {
				state.notice = describeWriteError(err);
			}
		});
	}

	async function runAddGlossary() {
		const node = nodeOf(state.dto);
		if (!node) return;
		const keyword = field("glossary-keyword");
		if (!keyword) {
			state.notice = { type: "error", text: "请填写触发词。" };
			render();
			return;
		}
		await withBusy(async () => {
			try {
				// ⭐ 改挂保护：`glossary.keyword` 是主键，被别的节点占用时 store **静默改挂**。
				const index = await ctx.api.view({ name: "glossary" }).catch(() => null);
				const owner =
					index && Array.isArray(index.items) ? index.items.find((g) => g.keyword === keyword) : null;
				if (owner && owner.uri && owner.uri !== node.uri) {
					const ok = await confirmSimple(
						`触发词「${keyword}」已挂在 ${owner.uri}，继续将改挂到 ${node.uri}。`,
						"改挂",
					);
					if (!ok) return;
				}
				await addGlossary({ uri: node.uri, keyword });
				toast(ctx, `已添加触发词：${keyword}（该词现在可用于召回此记忆）`, "info");
				await load();
			} catch (err) {
				state.notice = describeWriteError(err);
			}
		});
	}

	async function runRemoveGlossary(keyword) {
		if (!keyword) return;
		await withBusy(async () => {
			try {
				await removeGlossary({ keyword });
				toast(ctx, `已移除触发词：${keyword}`, "info");
				await load();
			} catch (err) {
				state.notice = describeWriteError(err);
			}
		});
	}

	async function runAwakenAdd() {
		const node = nodeOf(state.dto);
		if (!node) return;
		await withBusy(async () => {
			try {
				// store 不校验 URI 是否存在（也不校验 stub）→ 这里以节点页正在展示的存活节点为准。
				const list = await awaken({ action: "list" });
				const current = Array.isArray(list && list.uris) ? list.uris.slice() : [];
				if (!current.includes(node.uri)) current.push(node.uri);
				await awaken({ action: "set", uris: current });
				toast(ctx, `醒来记忆现有 ${current.length} 条`, "info");
			} catch (err) {
				state.notice = describeWriteError(err);
			}
		});
	}

	async function runSetWorldTime() {
		const raw = field("world-time-input");
		if (!raw) {
			state.notice = {
				type: "error",
				text: "请填写时间（ISO、YYYY-MM-DD，或 +1d / -2h 这样的相对量）。",
			};
			render();
			return;
		}
		await withBusy(async () => {
			try {
				const info = await ctx.api.meta({}).catch(() => null);
				const base = info && info.world_time ? String(info.world_time) : null;
				if (/^[+-]/.test(raw) && !base) {
					const ok = await confirmSimple(
						"世界钟尚未设置，相对位移将基于真实系统时间（不是故事时间）。要继续吗？",
						"继续",
					);
					if (!ok) return;
				}
				const res = await setWorldTime({ value: raw });
				const absolute = res && res.world_time ? String(res.world_time) : raw;
				state.notice = {
					type: "info",
					text: `世界钟已设为 ${absolute}${base ? `（原为 ${base}）` : ""}`,
				};
				toast(ctx, `世界钟：${absolute}`, "info");
			} catch (err) {
				state.notice = describeWriteError(err);
			}
		});
	}

	// ── 渲染 ────────────────────────────────────────────────────────────────

	function render() {
		if (state.creating) {
			el.replaceChildren(h("section", { class: "mw-edit" }, [renderNotice(), renderCreateForm()]));
			return;
		}
		if (state.loading) {
			el.replaceChildren(h("div", { class: "mw-skeleton", "aria-busy": "true", text: "载入中…" }));
			return;
		}
		const node = nodeOf(state.dto);
		if (!node) {
			const info = state.error || { text: `未找到：${state.uri}` };
			el.replaceChildren(
				h("section", { class: "mw-edit" }, [
					h("article", {}, [
						h("header", { text: "无法编辑该记忆" }),
						h("p", { text: info.text }),
						info.hint ? h("p", { class: "mw-muted", text: info.hint }) : null,
						h("button", { type: "button", dataset: { action: "reload" }, text: "重试" }),
					]),
				]),
			);
			return;
		}
		el.replaceChildren(
			h("section", { class: "mw-edit" }, [
				renderNotice(),
				renderContentForm(node),
				renderMetaBlock(node),
				renderRevisions(node),
				renderDanger(),
				renderRelocate(node),
				renderEdges(node),
				renderGlossary(),
				renderAwaken(node),
				renderWorldTime(),
			]),
		);
	}

	function renderNotice() {
		if (!state.notice) return null;
		const n = state.notice;
		return h("article", { dataset: { kind: n.type || "info" }, role: "status" }, [
			h("p", { text: n.text }),
			n.hint ? h("p", { class: "mw-muted", text: n.hint }) : null,
			h("button", {
				type: "button",
				class: "secondary outline",
				dataset: { action: "dismiss-notice" },
				text: "知道了",
			}),
		]);
	}

	function renderCreateForm() {
		return h("article", {}, [
			h("header", { text: "新建记忆" }),
			h("p", {
				class: "mw-muted",
				text: "地址形如 core://identity/habits。若该地址已存在，会覆盖其正文（旧正文归档为修订）。",
			}),
			h("label", {}, [
				"地址 uri",
				h("input", { type: "text", dataset: { field: "create-uri" }, placeholder: "core://a/b" }),
			]),
			h("label", {}, ["正文", h("textarea", { dataset: { field: "create-content" }, rows: "6" })]),
			h("label", {}, [
				"重要度（0–10，数值越大越重要；5 = 普通）",
				h("input", { type: "number", min: "0", max: "10", value: "5", dataset: { field: "create-importance" } }),
			]),
			h("button", { type: "button", dataset: { action: "create" }, disabled: state.busy, text: "创建" }),
		]);
	}

	function renderContentForm(node) {
		const current = versionOf(node);
		const isStub = node.is_stub === true || node.is_stub === 1;
		return h("article", {}, [
			h("header", {}, [
				h("code", { text: node.uri }),
				" ",
				h("span", { class: "mw-muted", text: `当前 v${current === undefined ? 0 : current}` }),
				isStub ? h("span", { class: "mw-chip", text: "占位节点（尚无正文）" }) : null,
				node.shadowed === true ? h("span", { class: "mw-chip", text: "已遮蔽（原分支已回滚）" }) : null,
			]),
			h("form", { dataset: { form: "content" } }, [
				h("label", {}, [
					"正文",
					h("textarea", { dataset: { field: "content" }, rows: "10" }, [node.content || ""]),
				]),
				h("button", {
					type: "submit",
					dataset: { action: "save-content" },
					disabled: state.busy,
					text: "保存正文",
				}),
			]),
			h("div", { dataset: { slot: "diff" } }, []),
		]);
	}

	function renderMetaBlock(node) {
		return h("article", {}, [
			h("header", { text: "重要度与元数据" }),
			h("label", {}, [
				`重要度（数值越大越重要；当前 ★${Number(node.importance)}）`,
				h("input", {
					type: "range",
					min: "0",
					max: "10",
					step: "1",
					value: String(Number(node.importance)),
					dataset: { field: "importance" },
				}),
			]),
			h("p", {
				class: "mw-muted",
				text: "刻度：10 = 最重要 · 5 = 普通 · 0 = 边角料。改动就地提交（防抖 400ms），不产生修订。",
			}),
			h("dl", { class: "mw-kv" }, [
				h("dt", { text: "domain" }),
				h("dd", { text: node.domain }),
				h("dt", { text: "source" }),
				h("dd", { text: node.source }),
				h("dt", { text: "created_at" }),
				h("dd", { text: node.created_at }),
				h("dt", { text: "updated_ts" }),
				h("dd", { text: node.updated_ts }),
				h("dt", { text: "parent_uri" }),
				h("dd", { text: node.parent_uri === null ? "（根节点）" : node.parent_uri }),
			]),
			h("form", { dataset: { form: "meta" } }, [
				h("label", {}, [
					"想起条件 disclosure（留空 = 清除）",
					h("input", {
						type: "text",
						dataset: { field: "disclosure" },
						value: node.disclosure === null ? "" : node.disclosure,
					}),
				]),
				h("label", {}, [
					"节点世界时间 world_ts（留空 = 清除；与全局世界钟不是一回事）",
					h("input", {
						type: "text",
						dataset: { field: "world-ts" },
						value: node.world_ts === null ? "" : node.world_ts,
					}),
				]),
				h("button", { type: "submit", dataset: { action: "save-meta" }, disabled: state.busy, text: "保存条件与时间" }),
			]),
		]);
	}

	function renderRevisions(node) {
		const revs = Array.isArray(state.dto.revisions) ? state.dto.revisions.slice().reverse() : [];
		return h("article", {}, [
			h("header", { text: `修订史（${revs.length}）` }),
			revs.length === 0
				? h("p", { class: "mw-muted", text: "还没有修订——这条记忆从未改过正文。" })
				: h("table", { class: "striped" }, [
						h("thead", {}, [
							h(
								"tr",
								{},
								[
									h("th", { text: "版本" }),
									h("th", { text: "时间" }),
									h("th", { text: "署名" }),
									h("th", { text: "归档地址" }),
									h("th", { text: "" }),
								],
							),
						]),
						h(
							"tbody",
							{},
							revs.map((r) =>
								h("tr", {}, [
									h("td", { text: `v${r.version}` }),
									h("td", {
										text:
											r.created_at === null || r.created_at === undefined
												? "—"
												: String(r.created_at).slice(0, 19).replace("T", " "),
									}),
									h("td", { text: labelOf(r) }),
									h("td", { text: r.uri === null || r.uri === undefined ? "—" : r.uri }),
									h("td", {}, [
										h("button", {
											type: "button",
											class: "secondary outline",
											dataset: { action: "diff-rev", version: String(r.version) },
											text: "看差异",
										}),
										" ",
										h("button", {
											type: "button",
											class: "secondary outline",
											dataset: { action: "restore-rev", version: String(r.version) },
											disabled: state.busy,
											text: "恢复此版",
										}),
									]),
								]),
							),
						),
					]),
			h("p", {
				class: "mw-muted",
				text: `归档地址可能与当前地址不同——那是这条记忆改名前的旧地址（relocate 不改写历史修订）。当前地址：${node.uri}`,
			}),
		]);
	}

	function renderDanger() {
		return h("article", {}, [
			h("header", { text: "删除这条记忆" }),
			h("p", {
				class: "mw-muted",
				text: "删除会物理删掉节点行，级联删除子树。修订史会保留，正文可从『恢复已删记忆』页找回；重要度 / 想起条件 / 世界时间找不回。",
			}),
			h("button", { type: "button", dataset: { action: "forget" }, disabled: state.busy, text: "删除…" }),
		]);
	}

	function renderRelocate(node) {
		const edges = state.dto.edges || {};
		const incoming = Array.isArray(edges.incoming) ? edges.incoming : [];
		const dangling = incoming.filter((e) => e.dangling === true).length;
		return h("article", {}, [
			h("header", { text: "移动 / 改名" }),
			h("p", {
				class: "mw-muted",
				text: `旧地址 ${node.uri} 会保留为 alias，旧地址仍可解析（这不是缺陷，是设计）。`,
			}),
			h("p", {
				text:
					`⚠ 移动后，其它记忆指向「${node.uri}」的关联边将不再显示` +
					"（已知引擎缺陷：relocate 不更新边的目标地址。数据不会丢，但界面上看不到）。" +
					`受影响：${incoming.length} 条边${dangling > 0 ? `（其中 ${dangling} 条已是悬空边）` : ""}。` +
					"修复办法 = 移动后对受影响的目标重新「保存关联」。",
			}),
			h("form", { dataset: { form: "relocate" } }, [
				h("label", {}, [
					"目标地址",
					h("input", { type: "text", dataset: { field: "relocate-to" }, placeholder: "core://new/place" }),
				]),
				h("label", { class: "mw-muted" }, [
					h("input", { type: "checkbox", dataset: { field: "relocate-ack" } }),
					" 我明白，并会在移动后重新保存这些关联",
				]),
				h("button", { type: "submit", dataset: { action: "relocate" }, disabled: state.busy, text: "移动" }),
			]),
		]);
	}

	function renderEdges(node) {
		const edges = state.dto.edges || { outgoing: [], incoming: [] };
		const list = (edges.outgoing || []).concat(edges.incoming || []);
		return h("article", {}, [
			h("header", { text: "关联边" }),
			list.length === 0
				? h("p", { class: "mw-muted", text: "没有关联边。" })
				: h(
						"ul",
						{ class: "mw-row-list" },
						list.map((e) => {
							// ⭐ EdgeDTO.node_id 是「边的源」不是对端；渲染用 uri / resolved_uri。
							const peer = e.uri !== undefined && e.uri !== null ? e.uri : e.resolved_uri;
							return h("li", { class: e.dangling === true ? "mw-edge mw-edge--dangling" : "mw-edge" }, [
								h("span", {
									class: "mw-chip",
									text: e.direction === "incoming" ? "指向本节点" : "本节点指向",
								}),
								" ",
								e.dangling === true || !peer
									? h("span", { class: "mw-muted", text: "⚠ 悬空边（目标不存在）" })
									: h("a", { href: `#/node?uri=${encodeURIComponent(peer)}`, text: peer }),
								e.kind ? h("span", { class: "mw-muted", text: ` · ${e.kind}` }) : null,
							]);
						}),
					),
			h("p", {
				class: "mw-muted",
				text: "同一对 (本节点, 目标) 重复保存会覆盖原边的 kind——所以这个按钮的语义是「设置关联」。契约没有删边端点，删边请删源节点。",
			}),
			h("form", { dataset: { form: "edge" } }, [
				h("label", {}, [
					"目标地址",
					h("input", { type: "text", dataset: { field: "edge-target" }, placeholder: "core://other" }),
				]),
				h("label", {}, ["kind（可选）", h("input", { type: "text", dataset: { field: "edge-kind" } })]),
				h("button", { type: "submit", dataset: { action: "add-edge" }, disabled: state.busy, text: "保存关联" }),
			]),
		]);
	}

	function renderGlossary() {
		const items = Array.isArray(state.dto.glossary) ? state.dto.glossary : [];
		return h("article", {}, [
			h("header", { text: "触发词（glossary）" }),
			items.length === 0
				? h("p", { class: "mw-muted", text: "还没有触发词。" })
				: h(
						"ul",
						{ class: "mw-row-list" },
						items.map((g) =>
							h("li", { class: "mw-row" }, [
								h("code", { text: g.keyword }),
								" ",
								h("button", {
									type: "button",
									class: "secondary outline",
									dataset: { action: "remove-glossary", keyword: g.keyword },
									disabled: state.busy,
									text: "移除",
								}),
							]),
						),
					),
			h("p", { class: "mw-muted", text: "触发词会进全文检索——挂着它的记忆，正文没有该词也可能被召回。" }),
			h("form", { dataset: { form: "glossary" } }, [
				h("label", {}, ["新增触发词", h("input", { type: "text", dataset: { field: "glossary-keyword" } })]),
				h("button", { type: "submit", dataset: { action: "add-glossary" }, disabled: state.busy, text: "添加" }),
			]),
			h("p", { class: "mw-muted", text: "注意：触发词是主键，同一个触发词只能挂在一个节点上。" }),
		]);
	}

	function renderAwaken(node) {
		return h("article", {}, [
			h("header", { text: "醒来清单" }),
			h("p", {
				class: "mw-muted",
				text: `把 ${node.uri} 加入醒来清单（先读当前清单，去重追加）。`,
			}),
			h("button", {
				type: "button",
				dataset: { action: "awaken-add" },
				disabled: state.busy,
				text: "加入醒来清单",
			}),
			h("p", { class: "mw-muted", text: "醒来清单写入不记审计——审计页不会变化，这是预期行为。" }),
		]);
	}

	function renderWorldTime() {
		return h("article", {}, [
			h("header", { text: "世界钟（全局）" }),
			h("p", {
				class: "mw-muted",
				text: "世界钟是全局单一故事时间轴，与「节点世界时间」不是一回事：改节点的 world_ts 不动世界钟。",
			}),
			h("form", { dataset: { form: "world-time" } }, [
				h("label", {}, [
					"设为（ISO / YYYY-MM-DD / +1d / -2h）",
					h("input", { type: "text", dataset: { field: "world-time-input" }, placeholder: "+1d" }),
				]),
				h("button", {
					type: "submit",
					dataset: { action: "set-world-time" },
					disabled: state.busy,
					text: "设置世界钟",
				}),
			]),
		]);
	}
}

// ══════════════════════════════════════════════════════════════════════════════
// 恢复页（`#/deleted`）—— 数据源只有 `/api/revisions?deleted=1`
// ══════════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ 本页**不用 `/api/audit` 当数据源**（D5 §8.4）：`delete_node` / `restore_deleted` 是两条
 * 独立事件，靠状态重放推不出「现在哪些 URI 可恢复」。真相来源只有 revision 表。
 *
 * ⭐⭐ 本页的两个陷阱（P14 / §7.3）：
 *  1. **按 `node_id` 分组**：relocate 后又被删的节点会在列表里出现旧/新两行，背后是同一个
 *     `node_id`（`node_revisions.uri` 逐行不同）。不分组用户会以为有两份。
 *  2. **默认只对「最新 URI」开放恢复**：从旧 URI 恢复会**静默拿回改名前的旧正文**
 *     （不报错、界面还显示成功），并把 `node_id` 占住，导致从正确地址恢复时报约束错误。
 */
async function mountRestorePage(el, params, ctx) {
	const ac = new AbortController();
	const { signal } = ac;

	const state = { groups: [], loading: true, error: null, busy: false, notice: null };
	let expanded = new Set();

	el.addEventListener("click", onClick, { signal });

	await load();
	return function dispose() {
		ac.abort();
	};

	async function load() {
		state.loading = true;
		state.error = null;
		render();
		try {
			const body = await ctx.api.revs({ deleted: "1" });
			const items = Array.isArray(body && body.items) ? body.items : [];
			state.groups = groupDeleted(items);
		} catch (err) {
			state.error = describeWriteError(err);
			state.groups = [];
		} finally {
			state.loading = false;
			render();
		}
	}

	async function onClick(ev) {
		const target = ev.target instanceof Element ? ev.target.closest("[data-action]") : null;
		if (!target) return;
		const action = target.getAttribute("data-action");
		ev.preventDefault();
		if (action === "toggle-group") {
			const key = target.getAttribute("data-group");
			if (expanded.has(key)) expanded.delete(key);
			else expanded.add(key);
			render();
			return;
		}
		if (action === "reload") return void (await load());
		if (action === "dismiss-notice") {
			state.notice = null;
			render();
			return;
		}
		if (action === "restore" && !state.busy) {
			const uri = target.getAttribute("data-uri");
			await runRestore(uri);
		}
	}

	async function runRestore(uri) {
		state.busy = true;
		render();
		try {
			const ok = await confirmSimple(
				`将从修订史恢复 ${uri}。只带回正文：重要度 / 想起条件 / 世界时间会回落默认值，` +
					"来源会标为 import。级联删除的子树要逐条恢复，且必须父先子后（子先恢复会补一个占位父，堵死父的恢复）。要继续吗？",
				"恢复",
			);
			if (!ok) {
				state.notice = { type: "info", text: "已取消恢复。" };
				return;
			}
			await restore({ uri });
			toast(ctx, `已从修订史恢复：${uri}（来源标为 import）`, "info");
			state.notice = { type: "info", text: `已从修订史恢复：${uri}（来源标为 import）。` };
			await load();
		} catch (err) {
			state.notice = describeWriteError(err);
		} finally {
			state.busy = false;
			render();
		}
	}

	function render() {
		if (state.loading) {
			el.replaceChildren(h("div", { class: "mw-skeleton", "aria-busy": "true", text: "载入中…" }));
			return;
		}
		if (state.error) {
			el.replaceChildren(
				h("section", { class: "mw-deleted" }, [
					h("article", {}, [
						h("header", { text: "无法载入已删记忆" }),
						h("p", { text: state.error.text }),
						h("button", { type: "button", dataset: { action: "reload" }, text: "重试" }),
					]),
				]),
			);
			return;
		}
		el.replaceChildren(h("section", { class: "mw-deleted" }, [renderNotice(), renderBody()]));
	}

	function renderNotice() {
		if (!state.notice) return null;
		const n = state.notice;
		return h("article", { dataset: { kind: n.type || "info" }, role: "status" }, [
			h("p", { text: n.text }),
			n.hint ? h("p", { class: "mw-muted", text: n.hint }) : null,
			h("button", {
				type: "button",
				class: "secondary outline",
				dataset: { action: "dismiss-notice" },
				text: "知道了",
			}),
		]);
	}

	function renderBody() {
		const groups = state.groups;
		const head = h("header", {}, [
			h("h2", { text: "恢复已删记忆" }),
			h("p", {
				class: "mw-muted",
				text:
					"删除只删节点行，修订史保留。这里列出所有只剩修订史、没有活节点的地址。" +
					"恢复按 URI 深度升序排列（父先子后）。",
			}),
			h("p", {
				class: "mw-muted",
				text: "备份请直接复制 memory.db 文件——本页不提供导出（契约 §1.3 不做 export 端点）。",
			}),
		]);

		if (groups.length === 0) {
			return h("div", {}, [head, h("p", { class: "mw-muted", text: "没有可恢复的已删记忆。" })]);
		}

		return h(
			"div",
			{},
			[head].concat(
				groups.map((g) => {
					const open = expanded.has(g.key);
					const hiddenRows = g.rows.filter((r) => r !== g.latest);
					return h("article", { dataset: { uri: g.latest.uri } }, [
						h("header", {}, [
							h("code", { text: g.latest.uri }),
							" ",
							h("span", {
								class: "mw-muted",
								text: `${g.rows.reduce((sum, r) => sum + (Number(r.versions) || 0), 0)} 版修订`,
							}),
							g.rows.length > 1
								? h("span", { class: "mw-chip", text: `同一记忆的 ${g.rows.length} 个地址` })
								: null,
							g.hasChildrenInList
								? h("span", {
										class: "mw-chip",
										title: "有子节点也在这份列表里；子先恢复会给父补一个占位节点，堵死父的恢复",
										text: "有子节点待恢复",
									})
								: null,
						]),
						h("p", { class: "mw-muted", text: `最后归档：${g.latest.last_seen || "—"}` }),
						h("button", {
							type: "button",
							dataset: { action: "restore", uri: g.latest.uri },
							disabled: state.busy,
							text: "恢复这一条",
						}),
						hiddenRows.length > 0
							? h("details", { open: open }, [
									h("summary", {
										dataset: { action: "toggle-group", group: g.key },
										text: `${hiddenRows.length} 个历史地址（只读，默认折叠）`,
									}),
									h(
										"ul",
										{ class: "mw-row-list" },
										hiddenRows.map((r) =>
											h("li", { class: "mw-row" }, [
												h("code", { text: r.uri }),
												h("span", { class: "mw-muted", text: `（${Number(r.versions) || 0} 版）` }),
												h("p", {
													class: "mw-muted",
													text:
														"⚠ 历史地址：从此处恢复会拿回改名前的旧正文（静默，不报错），并占住这条记忆的 node_id，" +
														"导致从上面的当前地址恢复时报冲突。默认不可点——除非你确实要那一版。",
												}),
											]),
										),
									),
								])
							: null,
					]);
				}),
			),
		);
	}
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
 *
 * 取数用 `/api/tree?parentUri=&depth=3`（该端点的 `depth` 上限就是 3，契约 D1 §7.2），
 * 按 uri 前缀计数。更深的层**数不到**——这是**有意的保守降级**：宁可少报，也不谎报一个
 * 数不出来的规模；确认框文案里说明「至少 N 条」。取数失败时返回 1（即「至少它自己」）。
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

/**
 * 乐观锁冲突三选（§6.2）：放弃 / 覆盖 / 看差异。
 * 返回 `"discard" | "overwrite" | "diff" | null`。
 */
async function confirmStale(uri, expected, current, myContent) {
	const body = document.createElement("div");
	const p1 = document.createElement("p");
	p1.textContent = `该记忆已被外部修改（v${expected} → v${current}）：${uri}`;
	body.append(p1);
	const p2 = document.createElement("p");
	p2.textContent = "覆盖会把对方的 v" + String(current) + " 归档为修订（可回退）。";
	body.append(p2);

	const diffSlot = document.createElement("div");
	body.append(diffSlot);

	return new Promise((resolve) => {
		const dialog = document.createElement("dialog");
		const article = document.createElement("article");
		const head = document.createElement("header");
		const strong = document.createElement("strong");
		strong.textContent = "版本冲突";
		head.append(strong);

		const footer = document.createElement("footer");
		const discard = document.createElement("button");
		discard.type = "button";
		discard.className = "secondary";
		discard.textContent = "放弃我的修改";
		const diff = document.createElement("button");
		diff.type = "button";
		diff.className = "secondary outline";
		diff.textContent = "看差异";
		const overwrite = document.createElement("button");
		overwrite.type = "button";
		overwrite.textContent = "覆盖";
		footer.append(discard, diff, overwrite);

		article.append(head, body, footer);
		dialog.append(article);
		document.body.append(dialog);

		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			if (dialog.open && typeof dialog.close === "function") dialog.close();
			dialog.remove();
			resolve(value);
		};
		discard.addEventListener("click", () => done("discard"));
		diff.addEventListener("click", () => {
			diffSlot.replaceChildren(showDiff(myContent, "", "你的本地正文（服务端最新正文不可见时只显示本地）"));
		});
		overwrite.addEventListener("click", () => done("overwrite"));
		dialog.addEventListener("close", () => done(null));
		if (typeof dialog.showModal === "function") dialog.showModal();
		else dialog.setAttribute("open", "");
	});
}
