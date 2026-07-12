import type { LanguageModel } from 'ai';

export enum LLMProvider {
    OPENROUTER = 'openrouter',
    OPENAI_COMPATIBLE = 'openai-compatible',
}

export enum OPENROUTER_MODELS {
    // Generate object does not work for Anthropic models https://github.com/OpenRouterTeam/ai-sdk-provider/issues/165
    CLAUDE_4_5_SONNET = 'anthropic/claude-sonnet-4.5',
    CLAUDE_3_5_HAIKU = 'anthropic/claude-3.5-haiku',
    OPEN_AI_GPT_5 = 'openai/gpt-5',
    OPEN_AI_GPT_5_MINI = 'openai/gpt-5-mini',
    OPEN_AI_GPT_5_NANO = 'openai/gpt-5-nano',
    QWEN_3_CODER_FREE = 'qwen/qwen3-coder:free',
    OPEN_AI_GPT_OSS_20B_FREE = 'openai/gpt-oss-20b:free',
    OPEN_AI_GPT_OSS_120B_FREE = 'openai/gpt-oss-120b:free',
    COHERE_NORTH_MINI_CODE_FREE = 'cohere/north-mini-code:free',
    POOLSIDE_LAGUNA_M_FREE = 'poolside/laguna-m.1:free',
    NVIDIA_NEMOTRON_3_SUPER_FREE = 'nvidia/nemotron-3-super-120b-a12b:free',
    GOOGLE_GEMMA_4_31B_FREE = 'google/gemma-4-31b-it:free',
    OPENROUTER_FREE = 'openrouter/free',
}

interface ModelMapping {
    [LLMProvider.OPENROUTER]: OPENROUTER_MODELS;
    [LLMProvider.OPENAI_COMPATIBLE]: string;
}

export type InitialModelPayload = {
    [K in keyof ModelMapping]: {
        provider: K;
        model: ModelMapping[K];
    };
}[keyof ModelMapping];

export type ModelConfig = {
    model: LanguageModel;
    providerOptions?: Record<string, any>;
    headers?: Record<string, string>;
    maxOutputTokens: number;
    maxRetries?: number;
};

export const MODEL_MAX_TOKENS = {
    [OPENROUTER_MODELS.CLAUDE_4_5_SONNET]: 200000,
    [OPENROUTER_MODELS.CLAUDE_3_5_HAIKU]: 200000,
    [OPENROUTER_MODELS.OPEN_AI_GPT_5_NANO]: 400000,
    [OPENROUTER_MODELS.OPEN_AI_GPT_5_MINI]: 400000,
    [OPENROUTER_MODELS.OPEN_AI_GPT_5]: 400000,
    [OPENROUTER_MODELS.QWEN_3_CODER_FREE]: 1048576,
    [OPENROUTER_MODELS.OPEN_AI_GPT_OSS_20B_FREE]: 131072,
    [OPENROUTER_MODELS.OPEN_AI_GPT_OSS_120B_FREE]: 131072,
    [OPENROUTER_MODELS.COHERE_NORTH_MINI_CODE_FREE]: 256000,
    [OPENROUTER_MODELS.POOLSIDE_LAGUNA_M_FREE]: 262144,
    [OPENROUTER_MODELS.NVIDIA_NEMOTRON_3_SUPER_FREE]: 1000000,
    [OPENROUTER_MODELS.GOOGLE_GEMMA_4_31B_FREE]: 262144,
    [OPENROUTER_MODELS.OPENROUTER_FREE]: 200000,
} as const;
