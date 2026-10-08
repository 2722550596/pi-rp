import { RemoteApp } from "./app.ts";
import { createWsByteTransportFactory } from "./transport.ts";

const token = window.location.hash.slice(1);
const error = document.getElementById("error");
if (!token) {
	if (error) { error.textContent = "链接缺少访问 token"; error.hidden = false; }
	const status = document.getElementById("connection-status");
	if (status) status.textContent = "No access token";
} else {
	const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = `${scheme}//${window.location.host}/ws/${encodeURIComponent(token)}`;
	new RemoteApp(createWsByteTransportFactory(url)).start();
}
