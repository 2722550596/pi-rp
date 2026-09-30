/**
 * Node built-in re-exports for files that must stay textually free of `node:` specifiers
 * (browser bundle A2 watch list, 15-F §5.5 / check-browser-harness NODE_FREE_WATCH).
 *
 * - Node profile: byte-identical passthrough — every export IS the node built-in binding.
 * - Browser profile: this module is untouched, but the underlying `node:` specifiers are
 *   aliased by packages/browser-engine/build.mjs to packages/browser-engine/src/shims/*
 *   (browser-semantics implementations; see each shim's header for its contract).
 *
 * Add a re-export here instead of importing a builtin directly in a watched file.
 */

import * as nodeCrypto from "node:crypto";
import * as nodeModule from "node:module";
import * as nodeOs from "node:os";
import path from "node:path";
import * as nodeUrl from "node:url";

export default path;

export const join = path.join.bind(path);
export const resolve = path.resolve.bind(path);
export const dirname = path.dirname.bind(path);
export const basename = path.basename.bind(path);
export const isAbsolute = path.isAbsolute.bind(path);
export const relative = path.relative.bind(path);
export const normalize = path.normalize.bind(path);
export const extname = path.extname.bind(path);
export const parsePath = path.parse.bind(path);
export const sep = path.sep;
export const delimiter = path.delimiter;
export const win32 = path.win32;
export const posixPath = path.posix;

export const homedir = nodeOs.homedir;
export const tmpdir = nodeOs.tmpdir;
export const fileURLToPath = nodeUrl.fileURLToPath;
export const pathToFileURL = nodeUrl.pathToFileURL;

export const randomUUID = nodeCrypto.randomUUID;
export const createRequire = nodeModule.createRequire;
