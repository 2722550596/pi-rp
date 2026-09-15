/**
 * D2 — 纯路径策略（plan/memory-web/12-多库安全与路径校验.md §3、契约 §8.1）。
 *
 * 除 `isLocalBind`（`security.ts` 的纯函数）外零项目内 import —— 结构上不可能与
 * D1 的 `discovery.ts` / `registry.ts` 形成循环依赖（`12` §1 C1）。
 *
 * 本文件**不做**：类型检查（`stat().isFile()` 归 D1 的 `probeMemoryDb`）、
 * 只读探测（D1）、打开数据库（D1）、schema 校验（D1）。
 * 本文件**做**：归一化 + 逐段真实解析 / 一致性判定 —— 两者都只看路径。
 *
 * ⭐ 本文件的**第二个导出** `admitForRegistration` 是**仅注册路径**使用的硬链接准入判据
 * （`12` §3.2、§8.2c）。它 MUST NOT 被 `checkPathAllowed` 内部调用，也 MUST NOT 被
 * D1 的 `resolve`（R5 的每次重开路径）调用 —— 只有 `register` / `/api/databases/open`
 * 该调它（D1 的 C20）。判据相同、调用点必须不同（`12` §3.4 #3）。
 * 落点错的代价：做过 `cp -al` / `rsync --link-dest` 备份的用户，自己正常用的库
 * `nlink` 就是 2 ⇒ `?db=<那个库>` 被拒而不带 `?db=` 仍 200 ⇒ 整个 UI 报错（"默认打开即白屏"）。
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isLocalBind } from "./security.ts";

const NUL = String.fromCharCode(0);

/**
 * ⭐ 内核语义的真实路径解析：**逐段**走，`..` 在**已解析**的基础上回退。
 *
 * 为什么不能直接用 `realpathSync(候选)`：它对**不存在**的路径抛 ENOENT，
 * 而 create 必须接受尚不存在的路径（契约 §5.3）。
 * 为什么不能「逐级上溯到最深已存在祖先再 realpath」（`12` 的初稿，已被实测证伪）：
 * 那样会把 `roots/esc/../out/x.db`（esc 是 → 外的 symlink）**整体**交给一次 realpath，
 * 于是 `..` 在**词法**层面先被折叠掉，内核真正会打开的文件被掩盖（`12` §3.3 #7）。
 *
 * 返回 `uncertain`：遇到「说不准」的情况（悬空 symlink / 自环 / EACCES）置真 → 调用方拒绝。
 */
function realpathWalk(input: string): { real: string; uncertain: boolean } {
	// ⚠️⚠️ MUST NOT 用 `path.resolve` / `path.join` 取绝对串 —— 它们会**词法折叠** `..`，
	// 把本函数存在的意义（逐段看穿 symlink）当场抹掉。只能手工拼前缀/组件。
	// （`12` §3.4 #9：设计者在同一处栽了两次；这里是那次教训的落地行。）
	const abs = path.isAbsolute(input) ? input : `${process.cwd()}${path.sep}${input}`;
	const root = path.parse(abs).root;
	let real = root;
	let uncertain = false;
	for (const comp of abs.slice(root.length).split(path.sep)) {
		if (comp === "") continue;
		if (comp === "..") {
			real = path.dirname(real); // ⭐ 在「已解析」的基础上回退（内核语义）
			continue;
		}
		const next = real === path.sep ? `${real}${comp}` : `${real}${path.sep}${comp}`;
		try {
			real = realpathSync.native(next);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const missing = code === "ENOENT" || code === "ENOTDIR";
			// ⚠️ 这里曾有一个「内核自报真值」的旁路（`O_PATH|O_NOFOLLOW` + `readlinkSync`
			// `/proc/self/fd/N`），用来消除「`realpathSync.native` 失败而内核其实能打开」时的
			// 一致性误拒。**经实测判定不可达，已删除**：`realpathSync.native` 就是 Linux
			// `realpath(3)`，其 `..` 语义与本函数的逐段解析**一致**（也在已解析结果上回退）
			// ⇒ 不存在「它失败而内核成功」的那条路径。三条独立测量（删前跑的）：
			//   · 271,452 例穷尽组合（1–5 层 × 12 组件，含 symlink/悬空/`..`）：命中 0；
			//   · 4,000 例随机树 fuzz（插桩计数）：命中 0；
			//   · 6,000 例插桩跑：`ENOENT/ENOTDIR` 分支进 57,156 次，其中 `lstat().isFile()`
			//     为真者 **0** 次。
			// 删它的理由：**不可达代码 + 测试无法覆盖 = 未来读者会误以为它在防线里。**
			// 留痕胜过留代码；代价是丢了一处理论误拒面（20,000 例 fuzz 里一次都没出现）。
			let isLink = false;
			try {
				isLink = lstatSync(next).isSymbolicLink();
			} catch {
				isLink = false;
			}
			// 悬空/自环 symlink，或 EACCES 等 → 说不准；普通的不存在 → 合法（create 的目标）。
			if (isLink || !missing) uncertain = true;
			real = next;
		}
	}
	return { real, uncertain };
}

/** 词法包含。用 `path.relative` 而非 `startsWith`（兄弟目录会骗过 `startsWith`，契约 §5.2#2a）。 */
function inside(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return !(rel === "" || rel.startsWith("..") || path.isAbsolute(rel));
}

export interface PathPolicy {
	/** 允许的根目录。调用方可给相对路径；本函数会 resolve。 */
	roots: string[];
	/** 逃生舱：跳过包含性检查（契约 §5.4）。开启时 CLI MUST 打醒目警告。 */
	allowAnyPath: boolean;
}

export function checkPathAllowed(
	policy: PathPolicy,
	candidate: string,
): { ok: true; path: string } | { ok: false; detail: string } {
	if (typeof candidate !== "string" || candidate === "") {
		return { ok: false, detail: "路径不能为空。" };
	}
	// NUL MUST 显式拒绝。⚠️ 理由**不是**「path.resolve 会静默吞掉它」—— 那是错的（实测：
	// `path.resolve("/tmp/a\0b")` 长度 8、含 NUL、与输入逐字节相同，**不折叠**）。
	// 真实理由是：含 NUL 的路径在 `open(2)` 层**语义未定义**，且它必然是畸形输入。
	// ⭐ 副作用（也是好消息）：既然不折叠，`?db=<注册路径>%00` 归一后与注册路径**不全等**
	//   ⇒ 走 404，**不会**打到错库（契约 §4.2#1 的全等比较天然挡住）。
	if (candidate.includes(NUL)) {
		return { ok: false, detail: "路径不能包含 NUL 字节。" };
	}

	const resolved = path.resolve(candidate);

	// 逃生舱短路在 NUL 检查**之后**：NUL 是输入畸形，与「放宽范围」无关。
	if (policy.allowAnyPath) return { ok: true, path: resolved };

	const roots = Array.isArray(policy.roots) ? policy.roots : [];
	// 空 roots = 什么都不允许（保守缺省，**不是**「允许一切」）。
	if (roots.length === 0) return { ok: false, detail: "未配置任何允许的根目录（--roots）。" };

	// ⭐ 一致性判定（本模块的核心）：
	// 内核按**原始串**逐段走，我们返回的 id 按**归一化串**走。
	// 若不校验两者指向同一文件，`roots/esc/../out/x.db`（esc → 外）会出现
	// 「判定通过、id 落在 roots 内的一个不存在的路径、而内核打开的是 roots 外的文件」。
	const raw = realpathWalk(candidate);
	const norm = realpathWalk(resolved);
	if (raw.uncertain || norm.uncertain) {
		return { ok: false, detail: `无法确认真实路径（权限、悬空或循环符号链接）：${candidate}` };
	}
	if (raw.real !== norm.real) {
		return {
			ok: false,
			detail: `路径含歧义（symlink 与 ".." 组合会让内核打开的文件与你看到的 id 不是同一个）：${candidate}`,
		};
	}

	for (const root of roots) {
		const realRoot = realpathWalk(path.resolve(root));
		if (realRoot.uncertain) continue; // root 都说不准 → 不能用它做判据
		if (!inside(realRoot.real, raw.real)) continue;
		return { ok: true, path: resolved };
	}
	return {
		ok: false,
		detail: `路径不在允许范围内：${resolved}（允许的根：${roots.map((r) => path.resolve(r)).join(", ")}）`,
	};
}

/** R4（契约 §5.5）：非回环绑定 ⇒ 多库整体禁用。唯一依据是**绑定地址**，不是请求头。 */
export function multiDbEnabled(host: string): boolean {
	return isLocalBind(host);
}

/**
 * ⭐ **仅注册路径**使用的准入判据：硬链接守卫（契约 §5.2 末段、`12` §8.2c）。
 *
 * 硬链接**绕过** roots 包含性：`realpathSync` 对硬链接返回它**自己那个（roots 内的）名字**
 * （硬链接没有「目标」）⇒ 逐段真实解析对它**无感**。实测（`12` §8.2c）：
 *   roots 外 `victim.db` 与 roots 内 `hard.db` 同一 inode；realpath 判「在 roots 内」；
 *   `openMemoryStore(hard.db)` 把 `victim.db` 从 1 张表灌到 24 张。
 *
 * ⚠️⚠️ 本函数 **MUST NOT** 被 `registry.resolve`（R5 的每次重开路径）调用 —— 只给
 * `register` / `/api/databases/open` 用。理由（评审实测推翻了初版落点）：
 *   `cp -al` / `rsync --link-dest` 做过一次硬链接式备份后，**用户自己正常使用的库**
 *   `nlink` 就是 2（实测：备份前 1 → 备份后源库 2）。若把它放进每次解析的路径，
 *   `?db=<那个库>` 会被拒而不带 `?db=` 仍 200 ⇒ 同一个库两种结果，且 D4 对每个请求都附
 *   `?db=` ⇒ 选中该库后**整个 UI 报错**。
 *
 * 为什么放在注册口是**足够**的：roots 逃逸**只能由注册引入**（只有那一刻需要证明
 * 「这个路径指向 roots 内」）。已注册库的 nlink 从 1 变 2 只可能是本机硬链接
 * ⇒ 归 §8.1 已认领的攻击者类别，不构成**新的** roots 逃逸。
 *
 * 代价：一次 `statSync`（非热点路径：每次「打开」一次，不在 resolve 热路径上）。
 * `adopt`（进程库）**豁免** —— 与契约 §5.4「进程库不受 roots 约束」一致。
 */
export function admitForRegistration(candidate: string): { ok: true } | { ok: false; detail: string } {
	let nlink: number;
	try {
		nlink = statSync(path.resolve(candidate)).nlink;
	} catch {
		return { ok: true }; // 不存在 → create 的合法目标（§5.3）；类型/探测在后续步骤兜
	}
	if (nlink > 1) {
		return {
			ok: false,
			detail:
				`该文件有多个硬链接（nlink=${nlink}），无法确认它就是允许范围内的那个文件。` +
				`如果你用 cp -al / rsync --link-dest 做过硬链接式备份，请改用 --allow-any-path 或把它加进 --roots。`,
		};
	}
	return { ok: true };
}
