// ── 缓存 + 库身份（契约 §7.6 D2 强修法；§7.10 要求本文件可被 node 直接 import） ──
// ⚠️ 本文件 MUST NOT import 任何 DOM 相关模块（含 ../app.js）—— 否则测试无法 import 它。
// ⭐ 本文件的**全部理由**：treeCache 的值来自某个库，而键里没有库标识。
//    这个模块把「这些条目属于哪个库」与缓存放在一起，做到**单点**失效。

export const treeCache = new Map();

// undefined = 尚未认领（首次挂载认领但不 clear —— 否则每次 mount 都白掉缓存）
let cacheOwner;
let cacheGen = 0;

/** mount / mountSidebar 的第一句 MUST 调用它（唯一失效点）。 */
export function ensureCacheFor(currentDb) {
  const owner = typeof currentDb === "string" && currentDb !== "" ? currentDb : null;
  if (cacheOwner === undefined) {
    cacheOwner = owner;
    return;
  }
  if (cacheOwner !== owner) {
    treeCache.clear();
    cacheOwner = owner;
    cacheGen++; // 让在途响应失效（loadLayer 用）
  }
}

/** `loadLayer` 在 await 前后各取一次：不同 ⇒ 这次响应属于旧库，MUST 丢弃。 */
export function currentGen() {
  return cacheGen;
}

/**
 * 精确失效：只删该 uri 的祖先层与自身层，不整树重拉（既有语义，从 `tree.js` 搬来）。
 * ⚠️ 搬进来的理由：它是**缓存的所有者操作**，必须与 `treeCache` **同处一个模块** ——
 * 否则 `app.js` 的 `memory:changed` handler 得 `import("./views/tree.js")` 才能用它，
 * 那会把 DOM 副作用拖进一个纯逻辑路径（§10.0）。`parentOf` 是纯字符串函数，一并搬。
 */
export function invalidateTreeFor(uri) {
  if (!uri) {
    treeCache.clear();
    return;
  }
  const parent = parentOf(uri);
  for (const key of [...treeCache.keys()]) {
    const i = key.indexOf("|");
    const prefix = i === -1 ? "" : key.slice(i + 1);
    if (prefix === "" || prefix === uri || prefix === parent || uri.startsWith(`${prefix}/`)) treeCache.delete(key);
  }
}

/** 纯字符串：`core://` 是根，再往上没有父层（既有语义，从 `tree.js` 搬来，逐字不变）。 */
export function parentOf(uri) {
  const s = String(uri ?? "");
  const i = s.lastIndexOf("/");
  if (i === -1) return "";
  const head = s.slice(0, i);
  return head.endsWith("://") ? "" : head; // `core://` 是根，再往上没有父层
}
