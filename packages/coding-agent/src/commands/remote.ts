import { visibleWidth } from "@earendil-works/pi-tui";
import QRCode from "qrcode";
import type { CommandEntry } from "../core/slash-commands.ts";

const USAGE = "Usage: /remote [start|lan|stop|status]";

function renderShare(
	ctx: Parameters<NonNullable<CommandEntry["execute"]>>[0],
	info: { urls: string[]; qrUrl?: string; port: number },
	bindHost: string,
): void {
	if (info.urls.length === 0) {
		ctx.view.showStatus(`No LAN or Tailscale address was found (listening on ${bindHost}:${info.port}).`, "warning");
		return;
	}
	const links = info.urls
		.map((url, index) => `[Remote link${info.urls.length > 1 ? ` ${index + 1}` : ""}](${url})`)
		.join("\n");
	ctx.view.renderMessage(`${links}\nListening on ${bindHost}:${info.port}`, { markdown: true });
	if (!info.qrUrl) {
		ctx.view.showStatus('Loopback sharing is local-only. Use "/remote lan" to enable LAN access.');
		return;
	}
	void QRCode.toString(info.qrUrl, { type: "terminal" }).then((qr: string) => {
		const columns = process.stdout.columns;
		const available = columns === undefined ? undefined : columns - 2;
		if (available === undefined || qr.split("\n").some((line: string) => visibleWidth(line) > available)) return;
		ctx.view.renderMessage(qr);
	});
}

export const remoteCommand: CommandEntry = {
	usage: "/remote [start|lan|stop|status]",
	argHint: "[start|lan|stop|status]",
	autocomplete: (prefix) => ["start", "lan", "stop", "status"].filter((value) => value.startsWith(prefix)),
	execute: async (ctx) => {
		const remoteHost = ctx.remoteHost;
		if (!remoteHost) {
			ctx.view.showStatus("Remote host is only available in interactive TUI mode.", "error");
			return;
		}
		if (ctx.args.length > 1 || (ctx.args[0] && !["start", "lan", "stop", "status"].includes(ctx.args[0]))) {
			ctx.view.showStatus(USAGE, "error");
			return;
		}
		const command = ctx.args[0] ?? "start";
		try {
			if (command === "stop") {
				await remoteHost.stop();
				ctx.view.showStatus("Remote sharing stopped.");
			} else if (command === "status") {
				const status = await remoteHost.status();
				ctx.view.showStatus(
					status.running
						? `Remote sharing running on ${status.bindHost}:${status.port} (session ${status.sessionId}, ${status.participantCount} participant${status.participantCount === 1 ? "" : "s"}).`
						: `Remote sharing is stopped (bind host ${status.bindHost}).`,
				);
			} else {
				const info = command === "lan" ? await remoteHost.lan() : await remoteHost.start();
				const status = await remoteHost.status();
				renderShare(ctx, info, status.bindHost);
			}
		} catch (error) {
			ctx.view.showStatus(
				`Remote sharing failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	},
};
