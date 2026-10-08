import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out-dir");
const outDir = path.resolve(outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : path.join(root, "../../dist/server/remote-web"));
let esbuild;
try {
	const require = createRequire(path.join(root, "package.json"));
	esbuild = require("esbuild");
} catch {
	throw new Error("esbuild is required to build remote web; install it with npm i -D esbuild");
}
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await esbuild.build({ entryPoints: [path.join(root, "src/main.ts")], outfile: path.join(outDir, "app.js"), bundle: true, format: "iife", target: "es2020", minify: true, platform: "browser" });
await cp(path.join(root, "index.html"), path.join(outDir, "index.html"));
await cp(path.join(root, "styles.css"), path.join(outDir, "app.css"));
