/**
 * modes/interactive 构建期 no-op stub（15-F §5.4 短期方案，随 pi-tui stub 同批删除）。
 *
 * 工具文件对 interactive 组件（keybinding-hints / visual-truncate / theme / diff）的引用
 * 全部位于 renderer/格式化闭包内；浏览器剖面渲染由下游 UI 承担，本 stub 恒等/恒空。
 * 符号缺口 = esbuild "No matching export" 构建错误（A5 静态扫描兜底）。
 */

/** 主题对象占位：真实 Theme 为 interactive 剖面渲染用，浏览器剖面永不求值其字段。 */
export const theme: Record<string, unknown> = {};

export function getLanguageFromPath(_path: string): string | undefined {
	return undefined;
}

export function highlightCode(code: string, _language?: string): string {
	return code;
}

export function keyHint(): string {
	return "";
}

export function keyText(): string {
	return "";
}

export function truncateToVisualLines(text: string): string[] {
	return [text];
}

export function renderDiff(): { content: string } {
	return { content: "" };
}

// —— commands/builtins.ts / export-html 的主题与模型检索面（浏览器剖面恒等/恒空）——
export function getModelSearchText(_model: unknown): string {
	return "";
}

export function getThemeByName(_name: string): unknown {
	return undefined;
}

export function getResolvedThemeColors(_name?: string): Record<string, string> {
	return {};
}

export function getThemeExportColors(_name?: string): Record<string, string> {
	return {};
}

export function generateThemeVars(_name?: string): string {
	return "";
}

export function deriveExportColors(_bg: string): Record<string, string> {
	return {};
}

export function loadThemeFromPath(_path: string): unknown {
	return undefined;
}
