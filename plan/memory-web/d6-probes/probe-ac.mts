const { initTheme, theme } = await import("/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/modes/interactive/theme/theme.ts");
initTheme("dark");
const { createEditToolDefinition } = await import("/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/core/tools/edit.ts");
const { stripAnsi } = await import("/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/utils/ansi.ts");
const def = createEditToolDefinition(process.cwd());
const args = { path: "/tmp/probe-target.txt", edits: [{ oldText: "乙", newText: "乙乙" }] };
for (const ac of [false, true]) {
  const ctx: any = { args, toolCallId: "t1", invalidate: () => {}, lastComponent: undefined, state: {}, cwd: process.cwd(),
    executionStarted: true, argsComplete: ac, isPartial: false, expanded: false, showImages: false, isError: false };
  try {
    const comp = def.renderCall!(args, theme, ctx);
    const out = stripAnsi(comp.render(100).join("\n"));
    console.log(`argsComplete=${ac} OK, lines=${comp.render(100).length}, body=${JSON.stringify(out)}`);
  } catch (e) { console.log(`argsComplete=${ac} THREW: ${(e as Error).message}`); }
}
// renderResult with details.diff, argsComplete=false context (export shape)
const rctx: any = { args, toolCallId: "t1", invalidate: () => {}, lastComponent: undefined, state: {}, cwd: process.cwd(),
  executionStarted: true, argsComplete: false, isPartial: false, expanded: false, showImages: false, isError: false };
const res = { content: [{ type: "text", text: "Successfully replaced 1 block(s)" }], details: { diff: " 1 甲\n-2 乙\n+2 乙乙\n 3 丙", patch: "", firstChangedLine: 2 }, isError: false };
const rc = def.renderResult!(res as any, { expanded: false, isPartial: false }, theme, rctx);
console.log("renderResult(argsComplete=false):", JSON.stringify(stripAnsi(rc.render(100).join("\n"))));
