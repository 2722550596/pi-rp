/**
 * Browser-profile event bus — alias target for `core/event-bus-node.ts`
 * （A2 禁入：Node EventEmitter 面不进 browser bundle；node 构建不受影响）。
 *
 * 语义面 = event-bus-memory 的 platform EventTarget 实现（C 拆分定稿的浏览器可用总线），
 * `createEventBus` 签名一致（EventBusController），event-bus.ts 的 re-export 在浏览器
 * 构建中落到本模块。
 */
export { createMemoryEventBus as createEventBus } from "../../coding-agent/src/core/event-bus-memory.ts";
