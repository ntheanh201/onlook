import {
    LLMProvider,
    MODEL_MAX_TOKENS,
    OPENROUTER_MODELS,
    type InitialModelPayload,
    type ModelConfig
} from '@onlook/models';
import { assertNever } from '@onlook/utility';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';

export function initModel({
    provider: requestedProvider,
    model: requestedModel,
}: InitialModelPayload): ModelConfig {
    let model: LanguageModel;
    let providerOptions: Record<string, any> | undefined;
    let headers: Record<string, string> | undefined;
    let maxOutputTokens: number = getMaxOutputTokens(requestedProvider, requestedModel);
    let maxRetries: number | undefined;

    switch (requestedProvider) {
        case LLMProvider.OPENROUTER:
            model = getOpenRouterProvider(requestedModel);
            maxRetries = 0;
            headers = {
                'HTTP-Referer': 'https://onlook.com',
                'X-Title': 'Onlook',
            };
            providerOptions = {};
            const isAnthropic = requestedModel === OPENROUTER_MODELS.CLAUDE_4_5_SONNET || requestedModel === OPENROUTER_MODELS.CLAUDE_3_5_HAIKU;
            providerOptions = isAnthropic
                ? {
                    openrouter: { transforms: ['middle-out'] },
                    anthropic: { cacheControl: { type: 'ephemeral' } },
                }
                : providerOptions;
            break;
        case LLMProvider.OPENAI_COMPATIBLE:
            model = getOpenAICompatibleProvider(requestedModel);
            maxRetries = 0;
            providerOptions = {};
            break;
        default:
            assertNever(requestedProvider);
    }

    return {
        model,
        providerOptions,
        headers,
        maxOutputTokens,
        maxRetries,
    };
}

function getOpenRouterProvider(model: OPENROUTER_MODELS): LanguageModel {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || !apiKey.startsWith('sk-or-v1-')) {
        throw new Error('OPENROUTER_API_KEY must be set to a valid OpenRouter key');
    }
    const openrouter = createOpenRouter({ apiKey });
    return openrouter(model);
}

function getOpenAICompatibleProvider(model: string): LanguageModel {
    const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
    if (!baseURL) {
        throw new Error('OPENAI_COMPATIBLE_BASE_URL must be set to use an OpenAI-compatible provider');
    }

    const openaiCompatible = createOpenRouter({
        apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? 'local',
        baseURL,
        compatibility: 'compatible',
    });
    return openaiCompatible.chat(model);
}

function getMaxOutputTokens(provider: LLMProvider, model: OPENROUTER_MODELS | string): number {
    if (provider === LLMProvider.OPENROUTER) {
        return MODEL_MAX_TOKENS[model as OPENROUTER_MODELS];
    }

    const value = Number(process.env.OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS ?? 8192);
    return Number.isFinite(value) && value > 0 ? value : 8192;
}
