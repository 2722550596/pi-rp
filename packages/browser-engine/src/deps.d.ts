/**
 * highlight.js@10.7.3（coding-agent 有意 pin 的 ESM 版）不带类型声明，仓内也无
 * @types/highlight.js；tsc 系程序（含 dts-bundle-generator 的类型程序）对 hljs 深导入与 raw: 内联资产前缀
 * 全部深导入报 TS7016。此处补 shorthand ambient 声明（any 语义，与仓内 tsgo
 * 既有行为一致）。升级 hljs 至自带类型的版本后可删除。
 */
declare module "highlight.js/*";
declare module "raw:*";
