import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

const LLM_KEY = "conflux.llmApiKey";

export async function getLlmApiKey(): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    const { value } = await Preferences.get({ key: LLM_KEY });
    return value || "";
  }
  return "";
}

export async function setLlmApiKey(key: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (!key) {
    await Preferences.remove({ key: LLM_KEY });
    return;
  }
  await Preferences.set({ key: LLM_KEY, value: key });
}

export async function clearLlmApiKey(): Promise<void> {
  await setLlmApiKey("");
}
