const { initTheme, theme } = await import("/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/modes/interactive/theme/theme.ts");
initTheme("dark");
const { createEditToolDefinition } = await import("/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/core/tools/edit.ts");
const { stripAnsi } = await import("/home/yoshix7ti/projects/pi-rp/packages/coding-agent/src/utils/ansi.ts");
const def = createEditToolDefinition(process.cwd());
const args = { path: "/tmp/probe-target.txt", edits: [{ oldText: "乙", newText: "乙乙" }] };
for (const ac of [false, true]) {
  const state: any = {};
  const ctx: any = { args, toolCallId: "t1", invalidate: () => {}, lastComponent: undefined, state, cwd: process.cwd(),
    executionStarted: true, argsComplete: ac, isPartial: false, expanded: false, showImages: false, isError: false };
  const comp = def.renderCall!(args, theme, ctx);
  await new Promise(r => setTimeout(r, 50));   // let async computeEditsDiff settle
  def.renderCall!(args, theme, ctx);           // second pass (invalidate-style)
  const out = stripAnsi(comp.render(100).join("\n"));
  console.log(`argsComplete=${ac} → hasDiff=${out.includes("乙乙")} body=${JSON.stringify(out.trim().split("\n"))}`);
}
