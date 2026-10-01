import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type ByteTransport, type ByteTransportHandlers, PiClient } from "@earendil-works/pi-client";
import type { PiServerListener } from "@earendil-works/pi-server";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import {
	type CodingAgentPiServerOptions,
	type CodingAgentServerSessionStore,
	createCodingAgentPiServer,
} from "../../src/server/index.ts";

type PickStorageChoice<T extends { sessionStorageDir?: string; sessionStore?: CodingAgentServerSessionStore }> =
	T extends unknown ? Pick<T, "sessionStorageDir" | "sessionStore"> : never;
type StorageChoice = PickStorageChoice<CodingAgentPiServerOptions>;
type Assert<T extends true> = T;
type CodingAgentPiServerStorageTypeAssertions = [
	Assert<{ sessionStorageDir: string } extends StorageChoice ? true : false>,
	Assert<{ sessionStore: CodingAgentServerSessionStore } extends StorageChoice ? true : false>,
	Assert<Record<string, never> extends StorageChoice ? false : true>,
	Assert<
		{ sessionStorageDir: string; sessionStore: CodingAgentServerSessionStore } extends StorageChoice ? false : true
	>,
];
const storageTypeAssertions: CodingAgentPiServerStorageTypeAssertions = [true, true, true, true];
void storageTypeAssertions;

type TestConnection = {
	readonly closed: boolean;
	send(chunk: Uint8Array): Promise<void>;
	close(finalChunk?: Uint8Array): void | Promise<void>;
};
type TestConnectionHandler = { onData(chunk: Uint8Array): void; onClose(): void; onError(error: Error): void };
type TestAcceptor = (connection: TestConnection) => TestConnectionHandler;

class MemoryListener implements PiServerListener {
	private accept: TestAcceptor | undefined;
	start(accept: TestAcceptor): Promise<void> {
		this.accept = accept;
		return Promise.resolve();
	}
	async close() {
		this.accept = undefined;
	}
	connect(handlers: ByteTransportHandlers): ByteTransport {
		if (!this.accept) throw new Error("listener has not started");
		let serverHandler: TestConnectionHandler;
		let clientClosed = false;
		const serverConnection: TestConnection = {
			get closed() {
				return clientClosed;
			},
			send: async (chunk) => {
				if (!clientClosed) handlers.onData(chunk);
			},
			close: async () => {
				if (clientClosed) return;
				clientClosed = true;
				handlers.onClose();
			},
		};
		serverHandler = this.accept(serverConnection);
		return {
			send: async (chunk) => {
				if (clientClosed) throw new Error("connection closed");
				serverHandler.onData(chunk);
			},
			close: () => {
				if (clientClosed) return;
				clientClosed = true;
				serverHandler.onClose();
			},
		};
	}
}

describe("coding-agent PiServer Host", () => {
	test("routes isolated prompts, rejects unavailable models, restores persisted options and releases owned root", async () => {
		// Host storage must use the checked-out local filesystem; project cwd is intentionally separate.
		const root = await mkdtemp(join(process.cwd(), ".tmp-pi-coding-agent-host-"));
		const projectCwd = await mkdtemp(join(process.cwd(), ".tmp-pi-coding-agent-project-"));
		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "session-selected", reasoning: true },
			],
		});
		try {
			const defaultModel = faux.getModel("faux-1")!;
			const sessionModel = faux.getModel("session-selected")!;
			const auth = AuthStorage.inMemory();
			await auth.modify(defaultModel.provider, async () => ({ type: "api_key", key: "test-key" }));
			const modelRuntime = await ModelRuntime.create({
				credentials: auth,
				modelsPath: null,
				allowModelNetwork: false,
			});
			const modelConfig = (model: typeof defaultModel) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			});
			modelRuntime.registerProvider(defaultModel.provider, {
				baseUrl: defaultModel.baseUrl,
				api: defaultModel.api,
				models: [modelConfig(defaultModel), modelConfig(sessionModel)],
			});
			modelRuntime.registerProvider("faux-unauthed", {
				baseUrl: defaultModel.baseUrl,
				api: defaultModel.api,
				models: [{ ...modelConfig(defaultModel), id: "protected-model", name: "Protected Model" }],
			});
			const serverErrors: Error[] = [];
			const listener = new MemoryListener();
			const host = await createCodingAgentPiServer({
				sessionStorageDir: root,
				listeners: [listener],
				maxActiveRuntimes: 2,
				requestGatewayConfig: { defaultMaxConcurrency: 2 },
				modelRuntime,
				serverOptions: { onError: (error) => serverErrors.push(error) },
			});
			let client: PiClient | undefined;
			try {
				await expect(
					createCodingAgentPiServer({
						sessionStorageDir: root,
						listeners: [new MemoryListener()],
						maxActiveRuntimes: 1,
						requestGatewayConfig: { defaultMaxConcurrency: 1 },
						modelRuntime,
					}),
				).rejects.toMatchObject({ code: "busy", details: { reason: "root_owned" } });
				await host.start();
				client = await PiClient.connect({ transportFactory: (handlers) => listener.connect(handlers) });
				expect(client.snapshot?.models.some((model) => model.provider === "faux-unauthed")).toBe(false);
				await expect(
					client.createSession({ model: { provider: "missing-provider", id: "missing-model" }, cwd: projectCwd }),
				).rejects.toMatchObject({ code: "invalid_request" });
				await expect(
					client.createSession({ model: { provider: "faux-unauthed", id: "protected-model" }, cwd: projectCwd }),
				).rejects.toMatchObject({ code: "invalid_request" });
				expect(await client.listSessions()).toEqual([]);

				const first = await client.createSession({
					model: { provider: sessionModel.provider, id: sessionModel.id },
					thinkingLevel: "low",
					cwd: projectCwd,
					name: "first",
				});
				const second = await client.createSession({ cwd: projectCwd, name: "second" });
				expect(first.snapshot?.id).not.toBe(second.snapshot?.id);
				expect(first.snapshot?.name).toBe("first");
				expect(second.snapshot?.name).toBe("second");
				expect(first.snapshot?.model.id).toBe("session-selected");
				expect(second.snapshot?.model.id).toBe("faux-1");
				expect(first.snapshot?.thinkingLevel).toBe("low");
				const secondId = second.snapshot!.id;
				const secondInitialModel = second.snapshot!.model;
				const secondInitialThinking = second.snapshot!.thinkingLevel;
				await expect(first.setModel({ provider: "missing-provider", id: "missing-model" })).rejects.toMatchObject({
					code: "invalid_request",
				});
				await expect(first.setModel({ provider: "faux-unauthed", id: "protected-model" })).rejects.toMatchObject({
					code: "invalid_request",
				});
				expect(first.snapshot?.model).toEqual({ provider: sessionModel.provider, id: sessionModel.id });

				faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
				await first.prompt("private prompt one");
				await second.prompt("private prompt two");
				const firstRevisionBeforeDetach = first.snapshot!.revision;
				const firstTranscript = JSON.stringify(first.snapshot?.transcript);
				const secondTranscript = JSON.stringify(second.snapshot?.transcript);
				expect(firstTranscript).toContain("private prompt one");
				expect(firstTranscript).not.toContain("private prompt two");
				expect(secondTranscript).toContain("private prompt two");
				expect(secondTranscript).not.toContain("private prompt one");

				await expect(client.createSession({ cwd: projectCwd })).rejects.toMatchObject({
					code: "busy",
					details: { reason: "active_runtime_limit" },
				});
				const firstId = first.snapshot!.id;
				await first.detach();
				const reopened = await client.attachSession(firstId);
				expect(reopened.snapshot!.revision).toBeGreaterThanOrEqual(firstRevisionBeforeDetach);
				expect(reopened.snapshot?.id).toBe(firstId);
				expect(reopened.snapshot?.name).toBe("first");
				expect(reopened.snapshot?.model).toEqual({ provider: sessionModel.provider, id: sessionModel.id });
				expect(reopened.snapshot?.thinkingLevel).toBe("low");
				expect(JSON.stringify(reopened.snapshot?.transcript)).toContain("private prompt one");
				expect(JSON.stringify(reopened.snapshot?.transcript)).not.toContain("private prompt two");
				expect((await client.listSessions()).map((session) => session.id)).toContain(firstId);
				await reopened.detach();
				await second.detach();
				const reopenedDefault = await client.attachSession(secondId);
				expect(reopenedDefault.snapshot?.id).toBe(secondId);
				expect(reopenedDefault.snapshot?.model).toEqual(secondInitialModel);
				expect(reopenedDefault.snapshot?.thinkingLevel).toBe(secondInitialThinking);
				expect(serverErrors).toEqual([]);
			} catch (error) {
				if (serverErrors.length > 0) {
					throw new AggregateError([error, ...serverErrors], "PiServer host operation failed", { cause: error });
				}
				throw error;
			} finally {
				await client?.dispose();
				await host.close();
			}
			const nextHost = await createCodingAgentPiServer({
				sessionStorageDir: root,
				listeners: [new MemoryListener()],
				maxActiveRuntimes: 1,
				requestGatewayConfig: { defaultMaxConcurrency: 1 },
				modelRuntime,
			});
			await nextHost.close();
		} finally {
			faux.unregister();
			await Promise.all([
				rm(root, { recursive: true, force: true }),
				rm(projectCwd, { recursive: true, force: true }),
			]);
		}
	});
});
