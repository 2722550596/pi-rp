import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "@earendil-works/pi-client";

const HIGH_WATER_MARK = 256 * 1024;
const LOW_WATER_MARK = 64 * 1024;
const POLL_INTERVAL_MS = 16;

export function createWsByteTransportFactory(url: string): ByteTransportFactory {
	return (handlers: ByteTransportHandlers) => {
		let resolveFactory: (transport: ByteTransport) => void = () => {};
		let rejectFactory: (error: Error) => void = () => {};
		const promise = new Promise<ByteTransport>((resolve, reject) => { resolveFactory = resolve; rejectFactory = reject; });
		let socket: WebSocket;
		try { socket = new WebSocket(url); }
		catch (error) { rejectFactory(error instanceof Error ? error : new Error(String(error))); return promise; }
		socket.binaryType = "arraybuffer";
		let opened = false;
		let terminal = false;
		let locallyClosed = false;
		let sendChain: Promise<void> = Promise.resolve();
		const fail = (error: Error) => {
			if (terminal) return;
			terminal = true;
			if (opened) handlers.onError(error); else rejectFactory(error);
		};
		socket.onopen = () => {
			if (terminal) return;
			opened = true;
			resolveFactory({
				send(chunk: Uint8Array): Promise<void> {
					const send = sendChain.then(async () => {
						while (!terminal && socket.readyState === WebSocket.OPEN && socket.bufferedAmount > HIGH_WATER_MARK) await new Promise<void>((done) => setTimeout(done, POLL_INTERVAL_MS));
						if (terminal || socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
						socket.send(chunk);
						while (socket.bufferedAmount > LOW_WATER_MARK) {
							if (terminal || socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket closed while sending");
							await new Promise<void>((done) => setTimeout(done, POLL_INTERVAL_MS));
						}
					});
					sendChain = send.catch(() => {});
					return send;
				},
				close(): void {
					if (locallyClosed) return;
					locallyClosed = true;
					try { socket.close(); } catch { /* already closed */ }
				},
			});
		};
		socket.onmessage = (event: MessageEvent) => {
			if (terminal) return;
			if (!(event.data instanceof ArrayBuffer)) {
				fail(new Error("Remote WebSocket sent a non-binary message"));
				try { socket.close(); } catch { /* already closed */ }
				return;
			}
			try { handlers.onData(new Uint8Array(event.data)); }
			catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
		};
		socket.onerror = () => fail(new Error("WebSocket transport error"));
		socket.onclose = (event: CloseEvent) => {
			if (terminal) return;
			terminal = true;
			// The host's listener.close() uses code 1001 with reason "server shutdown"
			// (docs/design/remote-web-control/01-共同上下文.md C1). onClose carries no
			// payload, so the host-shutdown signal must travel through onError.
			if (event.code === 1001 && `${event.reason}`.indexOf("server shutdown") >= 0) {
				if (!opened) rejectFactory(new Error("server shutdown"));
				else handlers.onError(new Error("server shutdown"));
				return;
			}
			if (!opened) rejectFactory(new Error(`WebSocket closed before opening (${event.code})`)); else handlers.onClose();
		};
		return promise;
	};
}
