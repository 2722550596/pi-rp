// D6 · T-D/P1 判别式探针：memory 两槽各画一份 vs edit 的「相等即跳过」
// 运行：cd packages/coding-agent && node --experimental-strip-types ../../plan/memory-web/d6-probes/probe-td-twoslot.mts
const { Text } = await import("@earendil-works/pi-tui");
const { initTheme } = await import("/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/modes/interactive/theme/theme.ts");
initTheme("dark");
const { ToolExecutionComponent } = await import("/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/modes/interactive/components/tool-execution.ts");
const { stripAnsi } = await import("/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/utils/ansi.ts");
const { renderDiff } = await import("/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/modes/interactive/components/diff.ts");
const DIFF = " 1 甲\n-2 乙\n+2 乙乙\n 3 丙";
// memory 的正确形态：call 槽画预览、result 槽恒画权威（无过滤）
const memoryLike: any = {
  name: "revise", label: "revise", description: "x", parameters: {},
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  renderCall: () => new Text(`revise core://r1\n${renderDiff(DIFF)}`, 0, 0),
  renderResult: (r: any) => new Text(renderDiff(r.details.diffs[0].diff), 0, 0),
};
async function run(def: any, args: any, details: any) {
  const ui: any = { requestRender: () => {} };
  const c: any = new ToolExecutionComponent(def.name, "r1", args, {}, def, ui, process.cwd());
  c.setArgsComplete();
  await new Promise((r) => setTimeout(r, 40));
  c.render(120);
  c.updateResult({ content: [{ type: "text", text: "ok" }], details, isError: false }, false);
  return stripAnsi(c.render(120).join("\n"));
}
const mem = await run(memoryLike, { uri: "core://r1" }, { diffs: [{ uri: "core://r1", diff: DIFF }] });
console.log("memory-like 两槽: '-2 乙' =", mem.split("-2 乙").length - 1, "'+2 乙乙' =", mem.split("+2 乙乙").length - 1);
// 对照：真 edit 定义（renderResult 在「与预览相同」时 return undefined ⇒ 计数 1）
const { createEditToolDefinition } = await import("/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/core/tools/edit.ts");
const editArgs = { path: "/tmp/probe-target.txt", edits: [{ oldText: "乙", newText: "乙乙" }] };
const ed = await run(createEditToolDefinition(process.cwd()), editArgs, { diff: DIFF });
console.log("edit 对照:        '-2 乙' =", ed.split("-2 乙").length - 1, "'+2 乙乙' =", ed.split("+2 乙乙").length - 1);
