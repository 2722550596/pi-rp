/**
 * highlight.js v10 子路径 ambient 声明（包内 tsgo 门）。
 *
 * highlight.js@10 无 exports map、无子路径类型（仅顶层 ./types/index.d.ts）；Node16 解析下
 * `highlight.js/lib/*.js` 子路径导入报 TS7016。此声明只在 browser-engine 的类型程序内生效，
 * 为 `utils/syntax-highlight.ts` 的传递依赖提供最小结构面（语言注册函数 + 高亮核心）。
 */
declare module "highlight.js/lib/core.js" {
	interface HighlightResult {
		value: string;
	}
	interface HighlightResultAuto {
		value: string;
		language?: string;
	}
	interface HighlightJsCore {
		highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): HighlightResult;
		highlightAuto(code: string, options?: string[] | { languageSubset?: string[] }): HighlightResultAuto;
		registerLanguage(name: string, language: (hljs: unknown) => unknown): void;
		getLanguage(name: string): { name: string } | undefined;
		listLanguages(): string[];
	}
	const hljs: HighlightJsCore;
	export default hljs;
}

declare module "highlight.js/lib/languages/*.js" {
	function language(hljs: unknown): unknown;
	export default language;
}
