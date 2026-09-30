/**
 * `raw:` 虚拟模块声明（build.mjs rawContentPlugin 的类型面）：静态资产以 text 内联，
 * 默认导出即文件字节内容。路径相对 packages/coding-agent/src/core/export-html/。
 */
declare module "raw:*" {
	const content: string;
	export default content;
}
