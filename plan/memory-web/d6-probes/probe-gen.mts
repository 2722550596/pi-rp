import { generateDiffString } from "/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/core/tools/edit-diff.ts";
function parseDiffLine(line:string){const m=line.match(/^([+-\s])(\s*\d*)\s(.*)$/);return m?{prefix:m[1],lineNum:m[2],content:m[3]}:null;}
const before = "伊莱走进酒馆。\n他看见薇拉。\n桌上有一封信。";
const after  = "伊莱走进酒馆。\n他看见薇拉，薇拉手里拿着一张地图。\n桌上有一封信。";
const { diff, firstChangedLine } = generateDiffString(before, after);
console.log("--- diff ---\n"+diff);
console.log("firstChangedLine:", firstChangedLine);
for (const l of diff.split("\n")) console.log(JSON.stringify(l).padEnd(40), parseDiffLine(l)?`PARSED(${parseDiffLine(l)!.prefix})`:"NULL→灰");
// append-only case (all added)
const { diff: d2 } = generateDiffString("a", "a\nb");
console.log("--- append diff ---\n"+JSON.stringify(d2));
