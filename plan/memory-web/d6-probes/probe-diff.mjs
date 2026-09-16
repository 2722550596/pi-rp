function parseDiffLine(line){const m=line.match(/^([+-\s])(\s*\d*)\s(.*)$/);if(!m)return null;return{prefix:m[1],lineNum:m[2],content:m[3]};}
const cases=["+1 hello","-1 hello"," 1 hello","+hello","+ hello","+++ b/foo","@@ -1,3 +1,4 @@","+  1 hello","+核心条件"];
for(const c of cases){const p=parseDiffLine(c);console.log(JSON.stringify(c).padEnd(22), p?`PARSED prefix=${JSON.stringify(p.prefix)} num=${JSON.stringify(p.lineNum)} content=${JSON.stringify(p.content)}`:"NULL -> fg(toolDiffContext) 灰");}
