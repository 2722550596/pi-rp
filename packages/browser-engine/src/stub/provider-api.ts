/**
 * streamFnOnly 构建里内置 provider API 实现的替身（build.mjs `streamFnOnlyPlugin`）。
 *
 * 只替换 `ai/src/api/*.lazy.ts` 的动态 import 目标，provider SDK（openai、@anthropic-ai/sdk、
 * @google/genai、mistral）因此不进包。真被调用时，lazyStream 把这里抛的错转成流上的 error 事件。
 */

const unavailable = (): never => {
	throw new Error(
		"pi-harness: built-in provider APIs are not bundled in this build (streamFnOnly); route model calls through llm.streamFn",
	);
};

export const stream = unavailable;
export const streamSimple = unavailable;
