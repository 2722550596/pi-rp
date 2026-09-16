const { initTheme } = await import("/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/modes/interactive/theme/theme.ts");
initTheme("dark");
const { renderDiff } = await import("/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/modes/interactive/components/diff.ts");
const { generateDiffString } = await import("/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/core/tools/edit-diff.ts");
const { diff } = generateDiffString("伊莱走进酒馆。\n他看见薇拉。\n桌上有一封信。", "伊莱走进酒馆。\n他看见薇拉，薇拉手里拿着一张地图。\n桌上有一封信。");
const out = renderDiff(diff);
console.log(JSON.stringify(out));
console.log("---- stripped ----");
console.log(out.replace(/\x1b\[[\d;]*m/g,""));
