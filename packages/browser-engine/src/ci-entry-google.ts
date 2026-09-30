/**
 * CI 守护 provider 变体 entry：google（15-F §11.1 A3 变体白名单，直连集成员）。
 * 不发 npm；断言 = 单 @google/genai SDK + 单 google catalog，@aws-sdk 恒禁。
 */
import { googleProvider } from "@earendil-works/pi-ai/providers/google";

export const ciGoogleProvider = googleProvider();
