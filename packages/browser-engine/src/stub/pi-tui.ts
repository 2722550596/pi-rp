/**
 * pi-tui 构建期 no-op stub（15-F §5.4 短期方案；E8 留痕：已知临时解，非砍除——
 * 真实 renderer 面在 node 剖面行为不变，浏览器剖面 renderer 永不被宿主调用）。
 *
 * 删除条件 = 正解合入（工具 renderer sidecar 拆分 + pi-tui sideEffects 声明/子导出，v1.x 反哺上游）。
 * 安全边界：工具文件对下列符号的引用全部位于 renderer/格式化闭包体内，无模块求值期执行；
 * 符号缺口 = esbuild "No matching export" 构建错误，由 scripts/check-browser-harness.mjs
 * 的 A5（stub 覆盖静态扫描 + bundle 零 packages/tui 输入断言）兜底。
 */

/** 空组件：node 剖面为 pi-tui 组件类（components/text.ts 等），此处保留可 new 的空壳。 */
export class Text {}
export class Box {}
export class Container {}
export class Spacer {}

export function truncateToWidth(text: string, _maxWidth: number): string {
	return text;
}

export function visibleWidth(text: string): number {
	return text.length;
}

export function getCapabilities(): Record<string, unknown> {
	return {};
}

export function getImageDimensions(_data: Uint8Array): { width: number; height: number } {
	return { width: 0, height: 0 };
}

export function hyperlink(text: string, _url?: string): string {
	return text;
}

export function imageFallback(): undefined {
	return undefined;
}

/** commands/builtins.ts 的模型选择面：浏览器剖面无交互选择器，空结果即协商禁用。 */
export function fuzzyFilter(_items: unknown[], _query: string): unknown[] {
	return [];
}
