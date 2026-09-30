/**
 * Pure constructors for the extension `pi.exec` implementation channel.
 *
 * There is deliberately no profile dispatch function: the assembly point selects the implementation with a one-line
 * expression over the negotiated shell capability (12-C §9 seam 3) and no profile string ever reaches shared code:
 *
 *     exec: capabilities.shell ? (env ? shellBridgeExec(env) : execCommand) : refusalExec()
 *
 * All constructors honor the node `execCommand` contract: resolve-oriented — they resolve an ExecResult and never
 * reject, so the same extension source needs no per-profile try/catch paths.
 */
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { ExecOptions, ExecResult } from "../exec.ts";
import type { ExecImpl } from "./types.ts";

/**
 * stderr marker distinguishing "no executor negotiated" from "the command ran and failed": consumers probe with
 * `code === 127 && stderr.startsWith("pi.exec unavailable")`.
 */
const UNAVAILABLE_PREFIX = "pi.exec unavailable";

/**
 * Constant structured refusal for profiles where the shell capability was not negotiated.
 *
 * `code: 127` is the shell convention for "command not found"; the stderr marker disambiguates the negotiated absence
 * from a command that actually exited 127.
 */
export function refusalExec(): ExecImpl {
	return async () => ({
		stdout: "",
		stderr: `${UNAVAILABLE_PREFIX}: shell_unavailable`,
		code: 127,
		killed: false,
	});
}

/**
 * Bridge `pi.exec` onto a host-injected {@link ExecutionEnv} shell (hosted profile with a negotiated shell).
 *
 * Mappings (12-C §4.5):
 * - `(command, args[])` spawn semantics become a single Shell command string via POSIX single-quote quoting;
 * - `ExecOptions.timeout` is milliseconds while `ShellExecOptions.timeout` is seconds (converted here);
 * - `ok` shell results map stdout/stderr/exitCode straight through;
 * - `timeout`/`aborted` errors resolve with `killed: true`;
 * - every other error resolves with code 127 and the error message on stderr (`shell_unavailable` keeps the
 *   negotiated-absence marker so the probe recipe above holds).
 */
export function shellBridgeExec(env: ExecutionEnv): ExecImpl {
	return async (command: string, args: string[], cwd: string, options?: ExecOptions): Promise<ExecResult> => {
		const result = await env.exec(quotePosixArgv(command, args), {
			cwd,
			timeout: options?.timeout !== undefined ? options.timeout / 1000 : undefined,
			abortSignal: options?.signal,
		});
		if (result.ok) {
			return {
				stdout: result.value.stdout,
				stderr: result.value.stderr,
				code: result.value.exitCode,
				killed: false,
			};
		}
		const { code, message } = result.error;
		if (code === "timeout" || code === "aborted") {
			return { stdout: "", stderr: message, code: 127, killed: true };
		}
		if (code === "shell_unavailable") {
			return { stdout: "", stderr: `${UNAVAILABLE_PREFIX}: shell_unavailable`, code: 127, killed: false };
		}
		return { stdout: "", stderr: message, code: 127, killed: false };
	};
}

/** Join an argv vector into one POSIX shell command string (single-quote rule: `'` becomes `'\''`). */
function quotePosixArgv(command: string, args: string[]): string {
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	return [command, ...args].map(quote).join(" ");
}
