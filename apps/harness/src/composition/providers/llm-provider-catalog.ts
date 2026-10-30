import { createDeepSeekPlugin } from "@0xsyncroot/adapter-deepseek";
import { createEchoLlmPlugin } from "@0xsyncroot/adapter-echo";
import { createOpenAIPlugin } from "@0xsyncroot/adapter-openai";
import type { PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import type { LlmProvider, RuntimeConfig, RuntimeSecrets } from "../runtime-config.js";

type LlmProviderFactory = (config: RuntimeConfig, secrets: RuntimeSecrets) => PluginDescriptor;

const LLM_PROVIDERS = Object.freeze({
  echo: () => createEchoLlmPlugin(),
  deepseek: (config, secrets) => {
    if (!secrets.deepSeekApiKey) throw new Error("DeepSeek API key is unavailable");
    return createDeepSeekPlugin({
      apiKey: secrets.deepSeekApiKey,
      ...(config.deepSeekBaseUrl ? { baseUrl: config.deepSeekBaseUrl } : {}),
      ...(config.deepSeekModel ? { model: config.deepSeekModel } : {}),
      thinking: config.deepSeekThinking ? "enabled" : "disabled",
    });
  },
  openai: (config, secrets) => {
    if (!secrets.openAIApiKey) throw new Error("OpenAI API key is unavailable");
    return createOpenAIPlugin({
      apiKey: secrets.openAIApiKey,
      ...(config.openAIBaseUrl ? { baseUrl: config.openAIBaseUrl } : {}),
      ...(config.openAIModel ? { model: config.openAIModel } : {}),
      ...(config.openAIOrganization ? { organization: config.openAIOrganization } : {}),
      ...(config.openAIProject ? { project: config.openAIProject } : {}),
      ...(config.openAIAllowInsecureInternal ? { allowInsecureInternal: true } : {}),
    });
  },
} satisfies Readonly<Record<LlmProvider, LlmProviderFactory>>);

/** Trusted, statically linked provider catalog. Arbitrary module names are never loaded from environment input. */
export function createLlmPlugin(config: RuntimeConfig, secrets: RuntimeSecrets): PluginDescriptor {
  return LLM_PROVIDERS[config.llmProvider](config, secrets);
}
