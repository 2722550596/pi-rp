/**
 * exportHtml:false 构建里 export-html-assets.ts 的替身（build.mjs `streamFnOnlyPlugin`）：
 * 不内联模板资产（约 270 KB），装配时不挂模板装载器；导出 HTML 会因找不到模板而报错。
 */

export function execExportTemplateAssets(): void {}
