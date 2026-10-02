import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Appends normalized server notifications to a private user-level log file. */
export class McpServerLog {
	private readonly path: string;
	constructor(path: string) {
		this.path = path;
	}
	write(server: string, value: unknown): void {
		const record = { time: new Date().toISOString(), server, message: value };
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	}
}
