/**
 * LLM 接入三态装配（15-F §4 S7 / 契约 §8 拍板）：`streamFn` > `proxyUrl` > `byok` 互斥。
 *
 * - `streamFn`：完全自管逃生口，直通 Agent 的 streamFn 契约。
 * - `proxyUrl`：上游 `streamProxy`（packages/agent/src/proxy.ts:118）包装，客户端零改动；
 *   本仓不建参考服务端（§6.1 拍板——自建网关=部署形态，协议即 pi-messages）。
 * - `byok`（缺省）：key 经 ModelRuntime 的 credentials 缝注入
 *   (`setRuntimeApiKey`, core/model-runtime.ts:552——runtime 级，不落盘)；可选
 *   per-provider `headers` 经 gateway 包装在 provider 分派前并入
 *   `options.headers`（model-runtime.ts:656 `mergeHeaders(auth.headers, options.headers)`）。
 *
 * 后两态的注入机制 = RequestGateway 子类覆盖 `streamSimple`（sdk.ts 的装配硬线消费
 * `gateway.streamSimple`，v1 不改 sdk 的 streamFn 结构）；并发闸门/其余方法走基类。
 */
import { type ProxyStreamOptions, streamProxy } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderHeaders,
	StreamFunction,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../../coding-agent/src/core/model-runtime.ts";
import {
	RequestGateway,
	type RequestGatewayConfig,
	type RequestIdentity,
} from "../../coding-agent/src/core/request-gateway.ts";
import type { PiHarnessLlmOptions } from "./assemble.ts";

type GatewayStream = (
	model: Model<any>,
	context: Context,
	options?: ModelsSimpleStreamOptionsLike,
	identity?: RequestIdentity,
	signal?: AbortSignal,
) => AssistantMessageEventStream;

/** Structural subset of `ModelsSimpleStreamOptions` the gateway layer threads through. */
interface ModelsSimpleStreamOptionsLike {
	headers?: ProviderHeaders;
	[key: string]: unknown;
}

/**
 * Gateway whose `streamSimple` delegates to a caller-supplied stream function.
 * Concurrency gating semantics stay with the base class (per-provider gates wrap
 * the delegated stream).
 */
class DelegatingRequestGateway extends RequestGateway {
	readonly #delegate: GatewayStream;

	constructor(modelRuntime: ModelRuntime, config: RequestGatewayConfig | undefined, delegate: GatewayStream) {
		super(modelRuntime, config);
		this.#delegate = delegate;
	}

	override streamSimple(
		model: Model<any>,
		context: Context,
		options?: ModelsSimpleStreamOptionsLike,
		identity?: RequestIdentity,
		signal?: AbortSignal,
	): AssistantMessageEventStream {
		return this.#delegate(model, context, options, identity, signal);
	}
}

/** S7 态二：streamProxy 包装（hosted/企业可选项；协议 POST {proxyUrl}/api/stream）。 */
export function proxyStreamGateway(
	modelRuntime: ModelRuntime,
	config: RequestGatewayConfig | undefined,
	proxyUrl: string,
	authToken?: string,
): RequestGateway {
	return new DelegatingRequestGateway(modelRuntime, config, (model, context, options) => {
		// streamProxy 无条件发送 Authorization 头（proxy.ts:157）：空 token 即匿名代理访问语义，
		// 由 PiHarnessLlmOptions.authToken 可缺省契约承载（hosted 代理可免鉴权部署）。
		const proxyOptions: ProxyStreamOptions = {
			...(options as Partial<ProxyStreamOptions>),
			proxyUrl,
			authToken: authToken ?? "",
		};
		return streamProxy(model, context, proxyOptions) as unknown as AssistantMessageEventStream;
	});
}

/** S7 态一：完全自管 streamFn 直通。 */
export function streamFnGateway(
	modelRuntime: ModelRuntime,
	config: RequestGatewayConfig | undefined,
	streamFn: StreamFunction,
): RequestGateway {
	return new DelegatingRequestGateway(
		modelRuntime,
		config,
		(model, context, options, _identity, signal) =>
			streamFn(model, context, { ...options, signal }) as AssistantMessageEventStream,
	);
}

/**
 * 三态分派（15-F §6.1 规则 4）。无模型时允许离线 session；已配置模型但无接入仍报错。
 */
export async function resolveLlmAssembly(
	modelRuntime: ModelRuntime,
	config: RequestGatewayConfig | undefined,
	llm: PiHarnessLlmOptions | undefined,
	model: Model<any> | undefined,
): Promise<
	{ kind: "gateway"; gateway: RequestGateway } | { kind: "default" } | { kind: "unavailable"; reason: string }
> {
	// 三态互斥：streamFn > proxyUrl > byok。
	if (llm?.streamFn) {
		return { kind: "gateway", gateway: streamFnGateway(modelRuntime, config, llm.streamFn) };
	}
	if (llm?.proxyUrl) {
		return { kind: "gateway", gateway: proxyStreamGateway(modelRuntime, config, llm.proxyUrl, llm.authToken) };
	}
	if (llm?.byok && llm.byok.length > 0) {
		const wrapped = await byokGateway(modelRuntime, config, llm.byok, llm.fetch);
		return wrapped ? { kind: "gateway", gateway: wrapped } : { kind: "default" };
	}
	if (!model) {
		return { kind: "unavailable", reason: "pi-harness: generation unavailable (no model or LLM access configured)" };
	}
	throw new Error("pi-harness: no LLM access configured (streamFn | proxyUrl | byok)");
}

/** BYOK + headers 的 gateway 包装（headers 注入 provider 分派）。 */
async function byokGateway(
	modelRuntime: ModelRuntime,
	config: RequestGatewayConfig | undefined,
	byok: PiHarnessLlmOptions["byok"],
	fetchImpl?: typeof globalThis.fetch,
): Promise<RequestGateway | undefined> {
	const headersByProvider = new Map<string, ProviderHeaders>();
	for (const entry of byok ?? []) {
		await modelRuntime.setRuntimeApiKey(entry.provider, entry.apiKey);
		if (entry.headers && Object.keys(entry.headers).length > 0) {
			headersByProvider.set(entry.provider, { ...entry.headers });
		}
	}
	if (headersByProvider.size === 0 && !fetchImpl) return undefined;
	return new DelegatingRequestGateway(modelRuntime, config, (model, context, options, _identity, _signal) => {
		const providerHeaders = headersByProvider.get(model.provider);
		const merged: ModelsSimpleStreamOptionsLike = {
			...(options ?? {}),
			...(fetchImpl ? { fetch: fetchImpl } : {}),
			...(providerHeaders ? { headers: { ...providerHeaders, ...(options?.headers ?? {}) } } : {}),
		};
		return modelRuntime.streamSimple(model, context, merged as Parameters<typeof modelRuntime.streamSimple>[2]);
	});
}
