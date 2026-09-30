/**
 * export-html 模板资产收编（Impl-B 边界申报交接项 → F 落地）。
 *
 * 五件模板资产（template.html/css/js + vendor/marked.min.js + vendor/highlight.min.js）
 * 属包资产而非状态：构建期经 esbuild `?raw` loader 内联进 bundle（build.mjs rawContentPlugin），
 * 装配期经 Impl-B 的 `setExportTemplateLoader` 缝注入；未设置时 node 缺省直读磁盘，
 * 行为逐字节不变。
 */

import templateCss from "raw:template.css";
import templateHtml from "raw:template.html";
import templateJs from "raw:template.js";
import hljsJs from "raw:vendor/highlight.min.js";
import markedJs from "raw:vendor/marked.min.js";
import { setExportTemplateLoader } from "../../coding-agent/src/core/export-html/index.ts";

const ASSETS: Record<string, string> = {
	"template.html": templateHtml,
	"template.css": templateCss,
	"template.js": templateJs,
	"vendor/marked.min.js": markedJs,
	"vendor/highlight.min.js": hljsJs,
};

let installed = false;

/** 幂等：装配完成时把 ?raw 资产挂到 export-html 的模板装载缝上。 */
export function execExportTemplateAssets(): void {
	if (installed) return;
	installed = true;
	setExportTemplateLoader((filename) => {
		const asset = ASSETS[filename];
		if (asset === undefined) {
			throw new Error(`pi-harness: unknown export-html template asset "${filename}"`);
		}
		return asset;
	});
}
