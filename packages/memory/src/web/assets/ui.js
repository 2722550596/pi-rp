// ── ui.js · 公共组件工厂层(L0 纯模块) ──────────────────────────────────────
// 设计权威:plan/memory-web-redesign/02-公共层与壳.md §3(API 逐个签名与语义);
// 类名权威:01-设计系统.md §7(徽章 §7.6 / URI §7.4+§7.16 / modal §7.10 / 按钮 §7.7)。
//
// 三条铁律(02 §2.1,违反即破坏分层):
//   1. 零 import——不 import 任何 in-repo 模块。通知走冻结事件契约 mw:toast(自派发,
//      与 app.js toast() 同构);导航/取数由调用方以参数或回调注入。
//   2. 零顶层副作用——判据(cwd = 本目录):
//        node -e "import('./ui.js')"   # MUST 不抛
//      全文件零网络调用、零存储访问、零顶层 DOM 访问、零模块级可变容器。
//      (上一行的字面 token 刻意不写——哨兵/V11c 按字面 grep 源文件,注释命中即误报。)
//   3. 零模块级可变状态——不持有 Map/Set/计数器;modal 的焦点归还值、asyncPage 的并发
//      序号全部是闭包局部。模块级常量(只读数组/对象)不算状态。
//   4. 最小 DOM API 面(为假 DOM 测试留门,02 §9):只用 createElement /
//      createTextNode / createDocumentFragment,与节点上的 className / textContent /
//      dataset / setAttribute / append / addEventListener / removeEventListener /
//      replaceChildren / remove / open / close / showModal / focus / isConnected。
//      全站硬规则:绝不把 HTML 串交给注入式渲染 API;来自 DB 的文本一律走 textContent。

// ════════════════════════════════════════════════════════════════════════════
// §A DOM 工厂:el / append / clear / $(合并全站 6 份:app.js el + edit/views/audit/raw/temp 五份 h)
// ════════════════════════════════════════════════════════════════════════════

/**
 * 查询选择器(root 缺省 document)。原样搬 app.js 的 `$`。
 * @param {string} sel CSS 选择器
 * @param {ParentNode} [root] 查询起点,缺省 document
 * @returns {Element|null}
 */
export function $(sel, root) {
  return (root ?? document).querySelector(sel);
}

/**
 * 唯一的元素工厂(六份合并语义矩阵,02 §3.1):
 *   class    → className(String())
 *   text     → textContent(String())——来自 DB 的文本一律走这里,绝不走注入式渲染
 *   dataset  → Object 逐键 node.dataset[k] = String(v)(null/undefined 值跳过)
 *   children → 与第三参等价(存在时跳过,兼容 app.js 现行为)
 *   on*      → 函数值 → addEventListener(k.slice(2), fn)
 *              ⚠️ MUST 走 addEventListener:setAttribute("onclick", String(fn)) 只会把函数
 *              源码写成属性文本,浏览器把它当表达式语句求值后丢弃 ⇒ 按钮点了没反应且不报错
 *              (死按钮教训,app.js:107-108)。
 *   其它     → true → setAttribute(k, "");false/null/undefined → 跳过(布尔属性语义,
 *              六份 h 的口径,合并裁定);否则 setAttribute(k, String(v))
 * @param {string} tag 标签名
 * @param {Object|null} [opts] 属性表,键序无关
 * @param {Node|string|Array|null} [children] 递归展开;null/undefined/false 跳过;
 *   字符串走 createTextNode(字面呈现,不被当 HTML)
 * @returns {HTMLElement}
 */
export function el(tag, opts, children) {
  const node = document.createElement(tag);
  if (opts) {
    for (const k of Object.keys(opts)) {
      const v = opts[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = String(v);
      else if (k === "text") node.textContent = String(v);
      else if (k === "dataset") {
        for (const dk of Object.keys(v)) {
          if (v[dk] !== undefined && v[dk] !== null) node.dataset[dk] = String(v[dk]);
        }
      } else if (k === "children") continue;
      else if (typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  // 合并矩阵:children 走 null/undefined/false 跳过(五份 h 的口径)。append 本体保持
  // app.js 原样(只跳 undefined/null),false 过滤在 el 这层收口。
  const rawKids = (opts && opts.children) ?? children;
  if (rawKids === false) return node;
  if (Array.isArray(rawKids)) append(node, rawKids.filter((k) => k !== null && k !== undefined && k !== false));
  else append(node, rawKids);
  return node;
}

/**
 * 把子项挂到 node 上(原样搬 app.js 的 append)。
 * @param {Node} node 目标节点
 * @param {Node|string|Array|null} [kids] 递归展开;null/undefined 跳过;字符串走 createTextNode
 * @returns {Node} 原样返回 node(可链式)
 */
export function append(node, kids) {
  if (kids === undefined || kids === null) return node;
  if (Array.isArray(kids)) for (const k of kids) append(node, k);
  else if (kids instanceof Node) node.append(kids);
  else node.append(document.createTextNode(String(kids)));
  return node;
}

/**
 * 清空节点全部子内容(原样搬 app.js 的 clear)。
 * @param {Node|null} node 目标节点(null 安全)
 * @returns {Node|null} 原样返回 node
 */
export function clear(node) {
  if (node) node.replaceChildren();
  return node;
}

// ════════════════════════════════════════════════════════════════════════════
// §B 三态:skeleton / asyncPage / renderNotice / errorCard
// ════════════════════════════════════════════════════════════════════════════

/**
 * 骨架块(统一壳 4×span 与视图 text 版两种形状,01 §7.14)。
 * @param {{lines?: number, label?: string}} [opts] lines 默认 4,label 默认 "载入中…"
 * @returns {HTMLElement} div.mw-skeleton[aria-busy=true](lines 个 span;label 走 textContent)
 */
export function skeleton(opts) {
  const o = opts || {};
  const lines = Number.isFinite(Number(o.lines)) ? Math.max(0, Math.floor(Number(o.lines))) : 4;
  const label = o.label === undefined ? "载入中…" : o.label;
  const box = el("div", { class: "mw-skeleton", "aria-busy": "true" });
  for (let i = 0; i < lines; i++) box.append(document.createElement("span"));
  if (label !== null && label !== false) box.append(document.createTextNode(String(label)));
  return box;
}

/**
 * 三态渲染器:loading 骨架 → 数据渲染 / 空态 / 错误卡,内置并发守卫(02 §3.2)。
 * 创建即首载(挂载即骨架→数据);refresh() 手动重取;慢响应不得覆盖新状态。
 * 并发守卫抄壳的 mountSeq/sidebarSeq 模式,序号是闭包局部(铁律 3)。
 *
 * @param {HTMLElement} host 挂载容器(工厂负责 replaceChildren)
 * @param {Object} spec
 *   load:     () => Promise<T>             必需
 *   render:   (data: T, host) => void|Node 必需;返回 Node 时由工厂 replaceChildren
 *   isEmpty:  (data: T) => boolean         可选;不传视为非空
 *   skeleton: () => Node                   可选;默认 ui.skeleton()
 *   empty:    () => Node|string            可选;默认 mw-empty 卡「暂无内容」
 *   onError:  (err, host, retry) => void    可选;默认 errorCard(err, { retry: refresh })
 * @returns {{ refresh(): Promise<void>, dispose(): void }}
 */
export function asyncPage(host, spec) {
  const s = spec || {};
  let seq = 0;
  let disposed = false;
  const refresh = async () => {
    const mine = ++seq;
    host.replaceChildren(s.skeleton ? s.skeleton() : skeleton());
    try {
      const data = await s.load();
      if (disposed || mine !== seq) return;
      if (s.isEmpty ? s.isEmpty(data) : false) {
        const n = s.empty ? s.empty() : emptyCard("暂无内容");
        host.replaceChildren(n instanceof Node ? n : document.createTextNode(String(n)));
      } else {
        const n = s.render(data, host);
        if (n) host.replaceChildren(n);
      }
    } catch (err) {
      if (disposed || mine !== seq) return;
      if (s.onError) s.onError(err, host, refresh);
      else host.replaceChildren(errorCard(err, { retry: refresh }));
    }
  };
  void refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      seq++;
    },
  };
}

function emptyCard(text) {
  return el("div", { class: "mw-empty" }, [el("p", { text })]);
}

/**
 * 信息/空态卡。app.js renderNotice 的实现原样迁此(签名不变:host-first),
 * app.js 原地再导出(databases.js/tree.js 的 import 零改动)。
 * @param {HTMLElement} hostEl 清空并填充
 * @param {string[]} lines 逐行文案(null/空行跳过)
 * @param {string} [actionLabel] 动作按钮文案(与 action 成对出现才渲染)
 * @param {() => void} [action] 动作回调
 */
export function renderNotice(hostEl, lines, actionLabel, action) {
  clear(hostEl);
  const box = el("div", { class: "mw-empty" });
  for (const line of lines) if (line) append(box, el("p", { text: line }));
  if (actionLabel && action) {
    append(box, el("p", null, [
      el("button", { type: "button", class: "mw-btn--outline", text: actionLabel, onclick: action }),
    ]));
  }
  hostEl.append(box);
}

/**
 * 错误文案表(自 app.js ERROR_TEXT 原样迁入的展示分支)。
 * invalid_db / 库不可达的「判定逻辑」留在 app.js.renderError(02 §2.2),这里只管展示。
 */
const ERROR_TEXT = {
  not_found: (m) => [m || "未找到。", "该地址在记忆库里不存在（可能已被移动或删除）。"],
  bad_request: (m) => [`请求参数不对：${m || ""}`, "这通常意味着界面生成了服务端不接受的参数。"],
  method_not_allowed: (m) => ["该请求方法不被允许。", m || ""],
  forbidden_origin: () => [
    "服务器拒绝了本页来源（Host / Origin 校验未通过）。",
    "若你是通过非 localhost 地址访问的，请改用 http://127.0.0.1:<port>。",
  ],
  invalid_db: () => [
    "该记忆库的 schema 版本本程序无法处理（通常高于当前程序）。",
    "请升级 pi-rp；若库已损坏，备份后指向一个空白路径即可冷启动新库。",
  ],
  conflict: (m) => [m || "目标被占用或已存在。", "服务端返回 conflict（409）。"],
  internal: (m) => [m || "无法连接记忆服务。", "服务可能未启动，或已退出。"],
};

/**
 * 错误卡(纯展示,不知道库的存在)。文案表沿用 app.js ERROR_TEXT 的展示分支。
 * @param {Error} err 取 `.code` / `.message`
 * @param {{retry?: () => void, backLabel?: string}} [opts]
 *   有 retry → 「重试」按钮;否则「回到树」(backLabel 可换文案;动作 = location.hash 赋值,
 *   ui.js 零 import 拿不到壳的 navigate,同 hash 边缘情形由壳层自行兜底)
 * @returns {HTMLElement} div.mw-empty 卡
 */
export function errorCard(err, opts) {
  const o = opts || {};
  const code = err && typeof err.code === "string" ? err.code : "internal";
  const make = ERROR_TEXT[code] ?? ERROR_TEXT.internal;
  const lines = make(err && err.message);
  const box = el("div", { class: "mw-empty" });
  for (const line of lines) if (line) append(box, el("p", { text: line }));
  const action = o.retry
    ? el("button", { type: "button", class: "mw-btn--outline", text: "重试", onclick: o.retry })
    : el("button", {
        type: "button",
        class: "mw-btn--outline",
        text: o.backLabel ?? "回到树",
        onclick: () => { location.hash = "#/tree"; },
      });
  append(box, el("p", null, [action]));
  return box;
}

// ════════════════════════════════════════════════════════════════════════════
// §C modal:openModal / confirmModal / choiceModal(F1 四项:× / 遮罩 / Esc / 焦点归还)
// ════════════════════════════════════════════════════════════════════════════

/** ModalAction 的 kind → 按钮类(01 §7.7:secondary = 元素缺省,不写类)。 */
const MODAL_KIND_CLASS = {
  primary: "mw-btn--primary",
  danger: "mw-btn--danger",
  outline: "mw-btn--outline",
  secondary: "",
};

function modalBodyNodes(body) {
  if (body === null || body === undefined) return [];
  if (body instanceof Node) return [body];
  if (Array.isArray(body)) return body;
  return [String(body)];
}

/**
 * 通用模态。F1 四项的实现点(02 §3.4):
 *   × 按钮   dismissible !== false 时 header 右侧 button.mw-modal__close[aria-label=关闭],点击 handle.close()
 *   遮罩点击 dialog 上的 click 且 e.target === dialog;dismissible === false 忽略
 *   Esc      原生 cancel→close 链;dismissible === false 时在 cancel 上 preventDefault(锁态)
 *   焦点归还 打开前存 document.activeElement;关闭时若仍 isConnected 则 focus()
 * DOM 结构按 01 §7.10 冻结:dialog.mw-modal > article > header(strong + ×) + div.mw-modal__body + footer。
 * 嵌套叠放靠 <dialog> 原生栈序;本模块不维护模态栈(铁律 3)。
 *
 * @param {Object} opts
 *   title       {string|Node}        必需;string 走 textContent(同时作 dialog 的 aria-label)
 *   body        {Node|Node[]|string} 必需;string 走 textContent
 *   actions     {ModalAction[]|null} footer 按钮;省略/null = 无 footer
 *   dismissible {boolean = true}     false 时:无 ×、遮罩点击忽略、Esc 被 preventDefault
 * @returns {ModalHandle}
 *   el     {HTMLDialogElement}
 *   close  {(value?) => void}  幂等;任何途径的关闭都汇入它
 *   closed {Promise<unknown>}  action.value(缺省 id)或 undefined(Esc/×/遮罩/close())
 *
 * @typedef ModalAction
 *   id        {string} 必需
 *   label     {string} 必需
 *   kind      {"primary"|"secondary"|"danger"|"outline" = "secondary"}
 *   value     {unknown} close 时 resolve 的值,缺省 = id
 *   close     {boolean = true} false = 侧动作:点击不关(「看差异」型)
 *   onClick   {(handle: ModalHandle) => void}
 *   autofocus {boolean = false}
 */
export function openModal(opts) {
  const o = opts || {};
  const dismissible = o.dismissible !== false;
  const dialog = document.createElement("dialog");
  dialog.className = "mw-modal";
  if (typeof o.title === "string") dialog.setAttribute("aria-label", o.title);
  else dialog.setAttribute("aria-label", "对话框");

  const article = document.createElement("article");
  const header = document.createElement("header");
  const strong = document.createElement("strong");
  if (o.title instanceof Node) strong.append(o.title);
  else strong.textContent = String(o.title ?? "");
  header.append(strong);
  if (dismissible) {
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "mw-modal__close";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => handle.close());
    header.append(closeBtn);
  }

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "mw-modal__body";
  if (typeof o.body === "string") bodyWrap.textContent = o.body;
  else for (const n of modalBodyNodes(o.body)) append(bodyWrap, n);
  article.append(header, bodyWrap);

  let restore = null;
  let settled = false;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const handle = {
    el: dialog,
    close: (value) => done(value),
    closed,
  };

  const actions = o.actions === null || o.actions === undefined ? [] : o.actions;
  if (actions.length > 0) {
    const footer = document.createElement("footer");
    for (const action of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = String(action.label);
      const cls = MODAL_KIND_CLASS[action.kind ?? "secondary"] ?? "";
      if (cls) btn.className = cls;
      btn.addEventListener("click", () => {
        if (typeof action.onClick === "function") action.onClick(handle);
        if (action.close !== false) done("value" in action ? action.value : action.id);
      });
      if (action.autofocus) btn.setAttribute("autofocus", "");
      footer.append(btn);
    }
    article.append(footer);
  }
  dialog.append(article);

  // ⭐ 焦点归还(F1 第四项):打开前记下触发元素;done 内若它仍 isConnected 则 focus 回去。
  //    原生 showModal 已给对话框内部焦点圈(Tab 不出洞),不需要自写 trap。
  restore = document.activeElement ?? null;

  const onBackdrop = (e) => { if (e.target === dialog) done(undefined); };
  const onClose = () => done(undefined);
  const onCancel = (e) => { if (!dismissible) e.preventDefault(); };

  function done(value) {
    if (settled) return;
    settled = true;
    dialog.removeEventListener("close", onClose);
    dialog.removeEventListener("cancel", onCancel);
    if (dismissible) dialog.removeEventListener("click", onBackdrop);
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    dialog.remove();
    if (restore && typeof restore.focus === "function" && restore.isConnected) {
      try { restore.focus(); } catch { /* 焦点归还失败不阻塞关闭 */ }
    }
    resolveClosed(value);
  }

  if (dismissible) dialog.addEventListener("click", onBackdrop);
  dialog.addEventListener("cancel", onCancel);
  dialog.addEventListener("close", onClose);
  document.body.append(dialog);
  // 无 showModal 的环境退化 setAttribute("open","")(保留 edit.js openDialog 的既有兜底)。
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  return handle;
}

/**
 * 二值确认 = openModal + 确定/取消。替代 edit.js openDialog 全部语义:
 * 确定 → true;取消/×/遮罩/Esc → false(与 openDialog 的「一律视为取消」对齐)。
 * @param {Object} [o]
 *   title {string = "请确认"}  message {string} 正文短句(走 textContent 的 <p>)
 *   body  {Node|Node[]} 追加正文(与 message 并存,顺序 message 在前)
 *   confirmText {string = "确定"}  cancelText {string = "取消"}
 *   danger {boolean = false} true → 确认键 mw-btn--danger(破坏性确认)
 *   dismissible {boolean = true}
 * @returns {Promise<boolean>}
 */
export function confirmModal(o) {
  const c = o || {};
  const kids = [];
  if (c.message !== undefined && c.message !== null) {
    kids.push(c.message instanceof Node ? c.message : el("p", { text: String(c.message) }));
  }
  for (const n of modalBodyNodes(c.body)) kids.push(n);
  return openModal({
    title: c.title ?? "请确认",
    body: kids,
    dismissible: c.dismissible,
    actions: [
      { id: "cancel", label: c.cancelText ?? "取消", kind: "secondary" },
      { id: "confirm", label: c.confirmText ?? "确定", kind: c.danger ? "danger" : "primary", autofocus: true, value: true },
    ],
  }).closed.then((v) => v === true);
}

/**
 * 多值选择。关闭途径(Esc/×/遮罩)→ null;action 点击 → action.value(缺省 id)。
 * 替代 edit.js confirmStale:「看差异」用 { close:false, onClick } 侧动作,模态保持打开。
 * @param {{ title: string|Node, body: Node|Node[]|string, actions: ModalAction[], dismissible?: boolean }} o
 * @returns {Promise<unknown|null>}
 */
export function choiceModal(o) {
  const c = o || {};
  return openModal(c).closed.then((v) => (v === undefined ? null : v));
}

// ════════════════════════════════════════════════════════════════════════════
// §D 徽章:importanceBadge / sourceBadge / stubChip / shadowedBadge / discBadge / discChip
//          / eventBadge / roleBadge(类名权威 = 01 §7.6;disc-badge.test.js 盯防红线)
// ════════════════════════════════════════════════════════════════════════════

/**
 * F6 四档判档(01 §7.6 冻结实现,档界 9-10 / 7-8 / 4-6 / 0-3)。
 * NaN → "low"(01 §7.6 冻结语义)。消灭 tree.js/temp.js/views.js 三份各写一份的现状。
 * @param {unknown} v
 * @returns {"hi"|"mid"|"low"|"min"}
 */
export function impTier(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "low";
  if (n >= 9) return "hi";
  if (n >= 7) return "mid";
  if (n >= 4) return "low";
  return "min";
}

const IMP_TIER_TITLE = {
  hi: "重要度 9–10:核心记忆",
  mid: "重要度 7–8:重要",
  low: "重要度 4–6:普通",
  min: "重要度 0–3:低",
};

/**
 * importance 色阶徽章:<span class="mw-imp mw-imp--{tier}">★n</span>,tier = impTier(n)
 * (9-10 hi / 7-8 mid / 4-6 low / 0-3 min,F6 冻结档界);title 写档位语义。
 * n === null/undefined(数据缺失)→ 返回 null(调用方 null-skip;disc-badge 同款纪律);
 * 其余非有限值交给 impTier(NaN → low)。
 * @param {unknown} n
 * @returns {HTMLElement|null}
 */
export function importanceBadge(n) {
  if (n === null || n === undefined) return null;
  const v = Number(n);
  const shown = Number.isFinite(v) ? v : 0;
  const tier = impTier(v);
  return el("span", { class: `mw-imp mw-imp--${tier}`, title: IMP_TIER_TITLE[tier], text: `★${shown}` });
}

/**
 * source 徽章(01 §7.6 属性驱动,非类名变体):<span class="mw-chip" data-src="manual|auto|import">。
 * 未知来源 → 中性 chip(不带 data-src),不猜;source 空 → null(null-skip)。
 * @param {unknown} source
 * @returns {HTMLElement|null}
 */
export function sourceBadge(source) {
  if (source === null || source === undefined || source === "") return null;
  const s = String(source);
  const known = s === "manual" || s === "auto" || s === "import";
  return el("span", { class: "mw-chip", dataset: known ? { src: s } : {}, text: s });
}

/**
 * stub 灰纹 chip:01 §7.6 的 mw-chip--stub(虚线 + 斜纹),文案「占位」(F6)。
 * @returns {HTMLElement}
 */
export function stubChip() {
  return el("span", { class: "mw-chip mw-chip--stub", text: "占位" });
}

// 冻结文案(契约 §6.6 + Main 广播 #2:MUST NOT 写成「已隐藏」;字符串与 tree.js 常量逐字一致)。
const SHADOWED_TEXT = "已遮蔽（原分支已回滚）";
const SHADOWED_TITLE = "该节点由自动写入产生，而它锚定的那条原文已不在当前分支上（原分支已回滚）。";

/**
 * 已遮蔽 chip(01 §7.6 的 mw-chip--shadowed;冻结文案,勿改一字)。
 * @returns {HTMLElement}
 */
export function shadowedBadge() {
  return el("span", { class: "mw-chip mw-chip--shadowed", title: SHADOWED_TITLE, text: SHADOWED_TEXT });
}

// ── 自 views.js 原样迁入。红线(01 §7.6/§11):discBadge/discChip 的类名输出
//    (mw-disc--entry/edge/dead、__icon/__label/__text)与 title 格式一字不改——
//    disc-badge.test.js:87-105 盯防。⭐ 琥珀色相纪律:「琥珀 = 想起条件(入口级);
//    灰虚线 = 关联条件(边)」,两者 MUST 一眼可辨(视觉语言也是契约)。

/**
 * 想起条件徽章。空值(空串/null/undefined)→ null = 不渲染(守卫语义零改动)。
 * @param {unknown} text 想起条件文本
 * @param {{kind?: string, label?: string, compact?: boolean}} [opts]
 *   kind:"entry"|"edge"|"dead"(缺省 entry);label:可见标签前缀(compact 时只进 title)
 * @returns {HTMLElement|null}
 */
export function discBadge(text, opts) {
  const o = opts || {};
  const t = foldWs(text);
  if (!t) return null; // 空 = 不渲染(`""`/null/undefined 一律视为「无值」)
  const kind = o.kind || "entry";
  const kids = [el("span", { class: "mw-disc__icon", "aria-hidden": "true" })];
  // `compact`(= discChip 的形态)只省掉可见的标签前缀,**不**动 `title` 的标签:
  // 树行装不下「想起条件」四个字,但 tooltip 仍须说清这是哪一类条件。
  if (o.label && !o.compact) kids.push(el("span", { class: "mw-disc__label", text: o.label }));
  kids.push(el("span", { class: "mw-disc__text", text: t }));
  return el("span", { class: `mw-disc mw-disc--${kind}`, title: `${o.label || "想起条件"}：${t}` }, kids);
}

/**
 * 行内短徽章(无可见标签前缀):树行 28px 定高用,长文本会把 URI/摘要挤成零宽。
 * ⚠️ **`label` 仍参与 `title`**,只是一行都不画:若照原稿写成
 *    `discBadge(text, { ...opts, label: "" })`,`discBadge` 的 `title` 兜底会把边条件
 *    标成「想起条件」——而边条件恰恰**不是**想起条件(契约 §3.2 例外条款)。
 * @param {unknown} text
 * @param {{kind?: string, label?: string}} [opts]
 * @returns {HTMLElement|null}
 */
export function discChip(text, opts) {
  return discBadge(text, { ...(opts || {}), compact: true });
}

/**
 * audit 事件徽章:输出 01 §7.6 冻结的 .mk-*(保名只换色),挂在 mw-chip 上。
 * 16 个已知事件名有专属配色;未知值原样显示(**不假定只有那 16 个**,mk-unknown)。
 * @param {unknown} kind 事件名(如 "update_node")
 * @returns {HTMLElement}
 */
const EVENT_CLASS = {
  insert_node: "mk-new",
  promote_stub: "mk-new",
  update_node: "mk-edit",
  rename_node: "mk-edit",
  delete_node: "mk-del",
  restore_deleted: "mk-del",
  add_edge: "mk-assoc",
  add_glossary: "mk-assoc",
  remove_glossary: "mk-assoc",
  set_world_time: "mk-time",
  import_snapshot: "mk-import",
  seed: "mk-import",
  recall: "mk-read",
  inject: "mk-read",
  autoretain_task: "mk-auto",
  autoretain_product: "mk-auto",
};

export function eventBadge(kind) {
  const name = typeof kind === "string" ? kind : String(kind ?? "");
  const cls = Object.hasOwn(EVENT_CLASS, name) ? EVENT_CLASS[name] : "mk-unknown";
  return el("span", { class: `mw-chip ${cls}`, text: name });
}

// 已知 role 的展示(rp-notify 是 TEMP 触发通知的 customType,temp-notify.ts:12)。
// 只读常量数组,不是可变状态(铁律 3)。
const KNOWN_ROLES = ["user", "assistant", "system", "tool", "rp-notify"];

/**
 * role 徽章:**必须容错未知值**(契约 §12-P5:每个 role 都可能是 customType)。
 * data-role 属性驱动 + data-known 标记(raw.js 现状保持,01 §8 映射表裁定不迁移类名)。
 * @param {unknown} role
 * @returns {HTMLElement}
 */
export function roleBadge(role) {
  const value = role === null || role === undefined || role === "" ? "(无角色)" : String(role);
  const known = KNOWN_ROLES.includes(value);
  return el("span", {
    class: "mw-chip",
    dataset: { role: value, known: known ? "1" : "0" },
    title:
      value === "rp-notify"
        ? "系统通知（TEMP 触发通知使用的 customType）"
        : known
          ? undefined
          : "自定义角色类型（原样显示）",
    text: value,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// §E 面包屑:breadcrumb / uriBreadcrumb(F7;泛化 tree.js:649 现有实现)
// ════════════════════════════════════════════════════════════════════════════

/**
 * 低层面包屑:nav.mw-bc > ol(01 §7.13)。items:[{ label, href?, title?, current? }];
 * current → span[aria-current=page],有 href → a[href],否则 span。null 项跳过。
 * @param {Array<{label: unknown, href?: string, title?: string, current?: boolean}>} items
 * @param {{label?: string}} [opts] aria-label,缺省「面包屑」
 * @returns {HTMLElement}
 */
export function breadcrumb(items, opts) {
  const o = opts || {};
  const nav = el("nav", { class: "mw-bc", "aria-label": String(o.label ?? "面包屑") });
  const list = el("ol");
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    const text = item.label === undefined || item.label === null ? "" : String(item.label);
    const title = item.title === undefined || item.title === null ? text : String(item.title);
    const li = el("li");
    if (item.current) li.append(el("span", { "aria-current": "page", title, text }));
    else if (item.href !== undefined && item.href !== null) li.append(el("a", { href: String(item.href), title, text }));
    else li.append(el("span", { text }));
    list.append(li);
  }
  nav.append(list);
  return nav;
}

/**
 * URI 面包屑:把 domain://a/b/c 拆成逐级可点段(段序 = [domain://, domain://a, …, 完整 uri],
 * 末段 aria-current="page")。吸收 tree.js breadcrumb 的段切逻辑并泛化跳转目标。
 * @param {Object} [o]
 *   uri     {string} 必需;空 → null(调用方 null-skip)
 *   domain  {string} 可选;缺省从 uri 取 scheme
 *   hrefFor {(u: string) => string} 缺省 u => `#/node?uri=${encodeURIComponent(u)}`
 *             (树页传 `#/tree?domain=…&uri=…` 即得现状行为;节点/编辑页用缺省)
 * @returns {HTMLElement|null}
 */
export function uriBreadcrumb(o) {
  const c = o || {};
  const u = c.uri === null || c.uri === undefined ? "" : String(c.uri);
  if (u === "") return null;
  const hrefFor = c.hrefFor ?? ((x) => `#/node?uri=${encodeURIComponent(x)}`);
  const i = u.indexOf("://");
  const root = c.domain !== undefined && c.domain !== null && c.domain !== ""
    ? `${c.domain}://`
    : (i === -1 ? u : u.slice(0, i + 3));
  const segs = [root];
  if (u !== root) {
    const rest = u.startsWith(root) ? u.slice(root.length) : "";
    let acc = root;
    for (const part of rest.split("/")) {
      if (part === "") continue;
      acc += part;
      segs.push(acc);
      acc += "/";
    }
    if (segs[segs.length - 1] !== u) segs.push(u); // 末段必须是完整 uri
  }
  return breadcrumb(segs.map((s, idx) => ({
    label: s === root ? root : lastSegment(s),
    title: s, // 每级显示段名、title 带全 URI(01 §7.13 显示策略,与 F2 同纪律)
    href: idx === segs.length - 1 ? undefined : hrefFor(s),
    current: idx === segs.length - 1,
  })));
}

// ════════════════════════════════════════════════════════════════════════════
// §F URI:isValidUri / lastSegment / uriLine / uriCopy / copyText(F2/F3)
// ════════════════════════════════════════════════════════════════════════════

/**
 * URI 合法性:非空、含 "://"、无空白字符。
 * 口径 = edit.js 新建校验 + F3 顶栏共用的一份实现(02 §3.7)。
 * @param {unknown} s
 * @returns {boolean}
 */
export function isValidUri(s) {
  const v = typeof s === "string" ? s : String(s ?? "");
  return v !== "" && v.includes("://") && !/\s/.test(v);
}

/**
 * 末段展示名:core://a/b/c → "c";根(core://)→ "core://"。
 * 自 tree.js lastSegment 原样迁入(树页面包屑/URI 件共用一份,避免双实现)。
 * @param {unknown} uri
 * @returns {string}
 */
export function lastSegment(uri) {
  const s = String(uri ?? "");
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1) || s;
}

/**
 * 一行 URI(F2/F8)。类名结构按 01 §7.4 冻结——.mw-uri 是 inline-flex 双子元素容器:
 *   <a|span class="mw-uri" title=全文><span class="mw-uri__prefix">core://a/</span><span class="mw-uri__name">c</span></a>
 * 前缀弱化、末段主视觉 = F8;单行省略交给 CSS,**不删字符**,title 永远是全文,
 * 与现状 slice 阶段性截断(temp.js snippet)本质不同。
 * href 给出 → 包 <a>(原生 hash 导航,无需 data-nav)。
 * full:true → 整体改用 .mw-uri-full(01 §7.16:详情页完整可读,word-break + user-select:all)。
 * @param {unknown} uri 空 → null(调用方 null-skip)
 * @param {{href?: string, full?: boolean}} [opts]
 * @returns {HTMLElement|null}
 */
export function uriLine(uri, opts) {
  const u = uri === null || uri === undefined ? "" : String(uri);
  if (u === "") return null;
  const o = opts || {};
  const tag = o.href === undefined || o.href === null ? "span" : "a";
  if (o.full) return el(tag, { class: "mw-uri-full", title: u, href: o.href, text: u });
  const i = u.lastIndexOf("/");
  const name = i === -1 ? u : (u.slice(i + 1) || u);
  const prefix = name === u ? "" : u.slice(0, i + 1);
  return el(tag, { class: "mw-uri", title: u, href: o.href }, [
    prefix ? el("span", { class: "mw-uri__prefix", text: prefix }) : null,
    el("span", { class: "mw-uri__name", text: name }),
  ]);
}

/**
 * 可点的复制件(F2 第二半):<button type="button" class="mw-btn--ghost">(底座 = 01 §7.7)
 * 内嵌 .mw-uri 双子元素结构,点击 copyText(uri)。label 为按钮内的前置文字。
 * @param {unknown} uri 空 → null
 * @param {{label?: string}} [opts]
 * @returns {HTMLElement|null}
 */
export function uriCopy(uri, opts) {
  const u = uri === null || uri === undefined ? "" : String(uri);
  if (u === "") return null;
  const o = opts || {};
  return el("button", {
    type: "button",
    class: "mw-btn--ghost",
    onclick: () => void copyText(u),
  }, [
    o.label ? `${o.label} ` : null,
    uriLine(u),
  ]);
}

/**
 * 复制到剪贴板 + toast 反馈(02 §3.7)。事件在 document 上派发(与 app.js toast() 同构;
 * 事件契约 mw:toast 不变,监听挂点修复归 app.js §4.4)。
 * navigator.clipboard.writeText 成功 → mw:toast(info,「{message}:{全文}」)并 return true;
 * 失败/无 API(非安全上下文)→ mw:toast(error) 并 return false(不引入 execCommand hack;
 * localhost 是安全上下文,主路径可用,02 §9.3 R2)。
 * @param {unknown} text
 * @param {{message?: string}} [opts] 成功 toast 前缀,缺省「已复制」
 * @returns {Promise<boolean>}
 */
export async function copyText(text, opts) {
  const o = opts || {};
  const value = text === null || text === undefined ? "" : String(text);
  const emit = (message, type) => {
    document.dispatchEvent(new CustomEvent("mw:toast", { detail: { message, type } }));
  };
  try {
    const clip = typeof navigator === "undefined" ? null : navigator.clipboard;
    if (!clip || typeof clip.writeText !== "function") throw new Error("clipboard API unavailable");
    await clip.writeText(value);
    emit(`${o.message ?? "已复制"}:${value}`, "info");
    return true;
  } catch {
    emit("复制失败:当前环境无法访问剪贴板", "error");
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// §G 列表与表单:renderList / field / form
// ════════════════════════════════════════════════════════════════════════════

/**
 * 清空并渲染列表;空态统一(02 §3.8)。替代各视图 `list.length === 0 ? 空文案 : ul.map(...)`
 * 的重复三段式;不追求列表虚拟化/复用——每次全量重挂是本项目既有口径。
 * @param {HTMLElement} host 清空并填充
 * @param {Array|null} items 非数组 → 视为 []
 * @param {Object} o
 *   render    {(item, i) => Node|null} 必需;返回 null 跳过(null-skip 纪律)
 *   empty     {string|() => Node}      空态,缺省「没有数据」;进 .mw-empty 卡
 *   className {string} 可选,渲染前覆盖 host 的 className
 * @returns {number} 实际渲染条数
 */
export function renderList(host, items, o) {
  const c = o || {};
  clear(host);
  if (c.className) host.className = String(c.className);
  const list = Array.isArray(items) ? items : [];
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    const n = c.render ? c.render(list[i], i) : list[i];
    if (!n) continue;
    host.append(n);
    count++;
  }
  if (count === 0) {
    const n = typeof c.empty === "function" ? c.empty() : (c.empty ?? "没有数据");
    const card = el("div", { class: "mw-empty" });
    if (n instanceof Node) card.append(n);
    else if (n !== false && n !== null && n !== undefined) append(card, el("p", { text: String(n) }));
    host.append(card);
  }
  return count;
}

/**
 * 单字段 = <label>[文本, 控件, hint?]。沿用 edit.js 的 label 包裹模式与 data-field 命名
 * (页面级事件委托用 [data-field=name] 读值,edit.js field() 语义)。
 * @param {Object} o
 *   label {string} 文本;name {string} 必需(→ dataset.field)
 *   type  {"text"|"textarea"|"number"|"range"|"checkbox"|"select" = "text"}
 *   value/placeholder/hint/min/max/step/rows/required/checked  直传控件
 *   options  [{value,label}]  (type=select)
 * @returns {{ root: HTMLElement, input: HTMLElement, name: string,
 *             value(): string, set(v: unknown): void }}
 *   value(): trimmed string;checkbox → 选中 "on"/未选 ""(与 edit.js field() 一致)
 */
export function field(o) {
  const c = o || {};
  const name = String(c.name);
  const type = c.type ?? "text";
  let input;
  if (type === "textarea") {
    input = document.createElement("textarea");
    if (c.rows !== undefined && c.rows !== null) input.setAttribute("rows", String(c.rows));
  } else if (type === "select") {
    input = document.createElement("select");
    for (const opt of c.options ?? []) {
      if (!opt) continue;
      const node = document.createElement("option");
      node.value = String(opt.value);
      node.textContent = String(opt.label ?? opt.value);
      input.append(node);
    }
  } else {
    input = document.createElement("input");
    input.type = type;
  }
  if (c.placeholder !== undefined && c.placeholder !== null) input.setAttribute("placeholder", String(c.placeholder));
  if (c.required === true) input.setAttribute("required", "");
  if (type === "number" || type === "range") {
    if (c.min !== undefined && c.min !== null) input.setAttribute("min", String(c.min));
    if (c.max !== undefined && c.max !== null) input.setAttribute("max", String(c.max));
    if (c.step !== undefined && c.step !== null) input.setAttribute("step", String(c.step));
  }
  if (type === "checkbox") input.checked = c.checked === true;
  else if (c.value !== undefined && c.value !== null) input.value = String(c.value);
  input.dataset.field = name;
  const root = el("label", null, [
    c.label === undefined || c.label === null ? "" : String(c.label),
    input,
    c.hint === undefined || c.hint === null || c.hint === "" ? null : document.createTextNode(String(c.hint)),
  ]);
  return {
    root,
    input,
    name,
    value() {
      if (type === "checkbox") return input.checked ? (input.value || "on").trim() : "";
      return typeof input.value === "string" ? input.value.trim() : "";
    },
    set(v) {
      if (type === "checkbox") input.checked = v === true || v === "on" || v === 1;
      else input.value = v === null || v === undefined ? "" : String(v);
    },
  };
}

/**
 * 表单卡 = <form data-form=name>[字段…, note?, 提交钮]。
 * 提交事件由页面级委托接(edit.js onSubmit 的 data-form 分发,不变)。
 * submitLabel 缺省不渲染提交钮(纯容器用);submitAction → 提交钮的 data-action。
 * @param {Object} o
 *   name {string} → form[data-form];fields {FieldHandle[]} 字段句柄列表
 *   note {string} 提示行(p.mw-muted);submitLabel {string} 提交钮文案
 *   submitAction {string} 提交钮 data-action
 * @returns {{ root: HTMLFormElement, el: HTMLFormElement,
 *             field(name: string): Object|null, value(name: string): string }}
 */
export function form(o) {
  const c = o || {};
  const formEl = document.createElement("form");
  if (c.name !== undefined && c.name !== null) formEl.dataset.form = String(c.name);
  const handles = [];
  for (const f of c.fields ?? []) {
    if (!f) continue;
    formEl.append(f.root ?? f);
    handles.push(f);
  }
  if (c.note) formEl.append(el("p", { class: "mw-muted", text: String(c.note) }));
  if (c.submitLabel) {
    const btn = el("button", { type: "submit", text: String(c.submitLabel) });
    if (c.submitAction !== undefined && c.submitAction !== null) btn.dataset.action = String(c.submitAction);
    formEl.append(btn);
  }
  const handle = {
    root: formEl,
    el: formEl,
    field(name) {
      return handles.find((f) => f.name === String(name)) ?? null;
    },
    value(name) {
      const f = handle.field(name);
      return f ? f.value() : "";
    },
  };
  return handle;
}

// ════════════════════════════════════════════════════════════════════════════
// §H 二梯队:dataTable / pager / select / nodeLink / sessionLabel / fmt 系 /
//          splitQuery / highlight / editorLabel / domainIndex(签名先行,02 §3.10)
// ════════════════════════════════════════════════════════════════════════════

/**
 * 数据表。行单元格 null/undefined → 跳过;Node 单元格原样装入 <td>。
 * @param {{headers?: string[], rows?: Array<Array<Node|string|null>>, className?: string}} o
 * @returns {HTMLTableElement}
 */
export function dataTable(o) {
  const c = o || {};
  const table = document.createElement("table");
  if (c.className) table.className = String(c.className);
  if (Array.isArray(c.headers) && c.headers.length > 0) {
    table.append(el("thead", null, [
      el("tr", null, c.headers.map((h) => el("th", { text: h === null || h === undefined ? "" : String(h), scope: "col" }))),
    ]));
  }
  const body = el("tbody");
  for (const row of c.rows ?? []) {
    const tr = el("tr");
    for (const cell of row ?? []) {
      if (cell === null || cell === undefined) continue; // 行单元格 null → 跳过
      tr.append(cell instanceof Node ? el("td", null, [cell]) : el("td", { text: String(cell) }));
    }
    body.append(tr);
  }
  table.append(body);
  return table;
}

/**
 * 分页条(1-based):「上一页 / n / m / 下一页」(02 §3.10;audit 的 offset 版由 03 映射)。
 * @param {{page: number, pageSize: number, total: number, onPage: (page: number) => void}} o
 * @returns {HTMLElement} nav.mw-pager
 */
export function pager(o) {
  const c = o || {};
  const size = Number(c.pageSize) > 0 ? Number(c.pageSize) : 1;
  const pages = Math.max(1, Math.ceil((Number(c.total) || 0) / size));
  const cur = Math.min(Math.max(Number(c.page) || 1, 1), pages);
  return el("nav", { class: "mw-pager" }, [
    el("button", { type: "button", text: "上一页", disabled: cur <= 1, onclick: () => c.onPage && c.onPage(cur - 1) }),
    el("span", { class: "mw-muted", text: ` ${cur} / ${pages} ` }),
    el("button", { type: "button", text: "下一页", disabled: cur >= pages, onclick: () => c.onPage && c.onPage(cur + 1) }),
  ]);
}

/**
 * 下拉选择(壳 #mw-db 模式的通用化)。onchange 用**属性赋值**不 addEventListener——
 * 可重复灌而不叠监听(app.js 教训,02 §3.10)。
 * @param {{options?: Array<{value: unknown, label?: unknown}>, value?: unknown, onchange?: (e: Event) => void}} o
 * @returns {HTMLSelectElement}
 */
export function select(o) {
  const c = o || {};
  const sel = document.createElement("select");
  for (const opt of c.options ?? []) {
    if (!opt) continue;
    const node = document.createElement("option");
    node.value = String(opt.value);
    node.textContent = String(opt.label ?? opt.value);
    sel.append(node);
  }
  if (c.value !== undefined && c.value !== null) sel.value = String(c.value);
  sel.onchange = typeof c.onchange === "function" ? c.onchange : null;
  return sel;
}

/**
 * 节点页链接:<a href="#/node?uri=…">(原生 hash 导航)。text 缺省 = lastSegment(uri)。
 * @param {unknown} uri
 * @param {{text?: string}} [opts]
 * @returns {HTMLAnchorElement}
 */
export function nodeLink(uri, opts) {
  const u = uri === null || uri === undefined ? "" : String(uri);
  const o = opts || {};
  const text = o.text === undefined ? lastSegment(u) : String(o.text);
  return el("a", { href: `#/node?uri=${encodeURIComponent(u)}`, text });
}

/**
 * session 的人类标签(F4:起始时间 + 首条消息摘要;UUID 只进 title/详情,不进标签)。
 * 输入 = SessionDTO {session_id, wall_first, wall_last, total, active, first_text}。
 * ⚠️ 摘要截断长度(40)是过渡值,待 03/F4 在 02 §3.10 落字后冻结(02 §9.4)。
 * 数据全缺时退回 session_id(选择器选项不能为空串)。
 * @param {Object|null} session
 * @returns {string}
 */
export function sessionLabel(session) {
  if (session === null || session === undefined) return "";
  if (typeof session !== "object") return String(session);
  const time = fmtTs(session.wall_first);
  const text = typeof session.first_text === "string" ? foldWs(session.first_text) : "";
  const parts = [];
  if (time !== "—") parts.push(time);
  if (text !== "") parts.push(text.length > 40 ? `${text.slice(0, 40)}…` : text);
  if (parts.length === 0) return String(session.session_id ?? "");
  return parts.join(" · ");
}

/**
 * 时间戳展示:ISO 串截到分钟("2026-01-02 03:04"),非串/空 → "—"。
 * 收编 audit.js formatTs / views.js formatUpdated / raw.js short 三份。
 * @param {unknown} ts
 * @returns {string}
 */
export function fmtTs(ts) {
  if (typeof ts !== "string" || ts === "") return "—";
  return ts.slice(0, 16).replace("T", " ");
}

/**
 * 空值转 "—"(收编 node.js dash)。
 * @param {unknown} v
 * @returns {string}
 */
export function dash(v) {
  return v === null || v === undefined || v === "" ? "—" : String(v);
}

/**
 * 数值兜底:非有限数 → 0(收编 views.js/temp.js 的 num;databases.js 的 null 版不收编)。
 * @param {unknown} v
 * @returns {number}
 */
export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 相对时间("刚刚"/"n 分钟前"/"n 小时前"/"n 天前",更旧回退 fmtTs)。零 DOM 纯函数。
 * @param {unknown} ts ISO 串
 * @param {number} [now] 比较基准毫秒(缺省调用时刻;测试可注入)
 * @returns {string}
 */
export function humanTime(ts, now) {
  if (typeof ts !== "string" || ts === "") return "—";
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return ts; // 解析不了就原样,不猜
  const base = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const diff = base - t;
  if (diff < 0) return fmtTs(ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return fmtTs(ts);
}

/**
 * 渲染自由文本前折叠换行(P16 缓解:别让内容伪造出行结构)。
 * 自 views.js/audit.js 同款实现收编。
 * @param {unknown} s
 * @returns {string}
 */
export function foldWs(s) {
  return s === null || s === undefined ? "" : String(s).replace(/\s+/g, " ").trim();
}

/**
 * 查询串切分(逐字迁自 search.js splitQuery,§6.3 规则 1):
 * 连续 CJK 段整体作一个片段(不做 bigram 切分——那会把「薇拉」碎成「薇」「拉」),
 * 拉丁/数字/下划线各自成片段。`core://identity` → ["core","identity"],不含 "://"。
 * @param {unknown} q
 * @returns {string[]}
 */
export function splitQuery(q) {
  const s = typeof q === "string" ? q : "";
  const m = s.match(/[\u4e00-\u9fff]+|[A-Za-z0-9_]+/g);
  return m ?? [];
}

/**
 * 关键词高亮(F9;逐字迁自 search.js highlight)。规则:对每个片段做 indexOf 循环
 * (允许重叠 from = idx + 1),合并相交区间后一次性建 DocumentFragment。
 * ⚠️ 不走注入式渲染:只 createTextNode + createElement("mark"),文本必须**字面**呈现。
 * @param {unknown} text
 * @param {unknown} query
 * @returns {DocumentFragment}
 */
export function highlight(text, query) {
  const frag = document.createDocumentFragment();
  const src = typeof text === "string" ? text : String(text ?? "");
  const terms = splitQuery(query).filter((t) => t.length > 0);
  if (terms.length === 0 || src.length === 0) {
    frag.append(document.createTextNode(src));
    return frag;
  }

  const lower = src.toLowerCase();
  const hits = [];
  for (const term of terms) {
    if (term.length === 0 || term.length > src.length) continue;
    const needle = term.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      hits.push([idx, idx + term.length]);
      from = idx + 1; // 允许重叠扫描
    }
  }
  if (hits.length === 0) {
    frag.append(document.createTextNode(src));
    return frag;
  }

  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const [s, e] of hits) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) frag.append(document.createTextNode(src.slice(cursor, s)));
    const mark = document.createElement("mark");
    mark.textContent = src.slice(s, e); // ⭐ 保留原文大小写
    frag.append(mark);
    cursor = e;
  }
  if (cursor < src.length) frag.append(document.createTextNode(src.slice(cursor)));
  return frag;
}

/**
 * 命中窗口摘录(F9;03 §10.8 定义的 ui 落位,02 §3.10 漏列由 Main 追加补齐)。
 * 在 content 上找首个任一词元(大小写不敏感)的命中下标,取 ±radius 窗口,
 * 过 highlight() 出带省略号的摘录:DocumentFragment = [前省略号?] 高亮窗口 [后省略号?]。
 * 省略号 = 纯文本节点(「…」);窗口高亮复用 highlight(字面呈现纪律不变)。
 * 无命中时退化取头部窗口——调用方契约(renderCard)只在正文确认命中后调用,此为防御。
 * @param {unknown} content 全文
 * @param {string[]} terms 已切分词元(splitQuery(q) 产物;空数组 → 窗口原文不标亮)
 * @param {number} [radius=80] 命中点两侧窗口半宽
 * @returns {DocumentFragment}
 */
export function hitExcerpt(content, terms, radius = 80) {
  const src = typeof content === "string" ? content : String(content ?? "");
  const frag = document.createDocumentFragment();
  if (src.length === 0) return frag;
  const list = Array.isArray(terms) ? terms.filter((t) => typeof t === "string" && t.length > 0) : [];
  const r = Number.isFinite(Number(radius)) && Number(radius) > 0 ? Math.floor(Number(radius)) : 80;
  const lower = src.toLowerCase();
  let idx = -1;
  for (const t of list) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx === -1) idx = 0;
  const start = Math.max(0, idx - r);
  const end = Math.min(src.length, idx + r);
  if (start > 0) frag.append(document.createTextNode("…"));
  frag.append(highlight(src.slice(start, end), list.join(" ")));
  if (end < src.length) frag.append(document.createTextNode("…"));
  return frag;
}

/**
 * 署名渲染统一版(契约 §9.2 冻结 + 05 §8.8 裁定的并集;02 §3.10 落点):
 *   非对象 / editor_source === undefined(两键皆缺、服务端没带这列)→ null
 *   (「没取到,省略整块」edit.js:213-214 与「没取到 ≠ 取到了但未知」node.js:23-25 两条边界都保留);
 *   editor_model 非空串 → 裸模型 id(§9.2:模型 id **全等**才是「同款」,显示必须就是 id);
 *   editor_source === null → 「系统」(restoreRevision 归档版是系统动作,05 §8.8 已裁定);
 *   "manual" → 「用户(Web UI)」;"auto" → 「自动写入(模型未知)」;"import" → 「导入」;
 *   其余取到了但不认识的值 → 「未知来源」。
 * @param {Object|null} rev RevisionDTO {editor_source, editor_model}
 * @returns {string|null}
 */
export function editorLabel(rev) {
  if (!rev || typeof rev !== "object") return null;
  if (rev.editor_source === undefined) return null;
  if (typeof rev.editor_model === "string" && rev.editor_model.length > 0) return rev.editor_model;
  const src = rev.editor_source;
  if (src === null) return "系统";
  if (src === "manual") return "用户（Web UI）";
  if (src === "auto") return "自动写入（模型未知）";
  if (src === "import") return "导入";
  return "未知来源";
}

/**
 * 域名 → 调色板序号(01 §4.5 冻结实现:任一域名稳定映射同一色,跨会话/主题/设备)。
 * FNV-1a 32bit;非加密。消费方:04 图谱域着色 + 侧栏域点(可选)。
 * CSS 侧:var(--mw-dom-${domainIndex(d) + 1})。
 * @param {unknown} domain
 * @returns {number} 0..9
 */
export function domainIndex(domain) {
  let h = 0x811c9dc5;
  const s = String(domain ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 10;
}
