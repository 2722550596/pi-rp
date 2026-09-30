/**
 * CI 守护 provider 变体 entry：openai（15-F §11.1 A3 变体白名单，直连集成员）。
 * 不发 npm；断言 = 单 openai SDK + 单 openai catalog，@aws-sdk 恒禁。
 */
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export const ciOpenaiProvider = openaiProvider();
