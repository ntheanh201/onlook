import { LLMProvider, OPENROUTER_MODELS, type InitialModelPayload } from '@onlook/models';

const OPENROUTER_MODEL_VALUES = new Set<string>(Object.values(OPENROUTER_MODELS));

function getOpenRouterModelFromEnv(
    name: string,
    fallback: OPENROUTER_MODELS,
): OPENROUTER_MODELS {
    const value = process.env[name];
    if (!value) {
        return fallback;
    }
    if (OPENROUTER_MODEL_VALUES.has(value)) {
        return value as OPENROUTER_MODELS;
    }
    console.warn(`Ignoring unsupported ${name}: ${value}`);
    return fallback;
}

export function getDefaultOpenRouterModel(): OPENROUTER_MODELS {
    return getOpenRouterModelFromEnv(
        'OPENROUTER_MODEL',
        OPENROUTER_MODELS.COHERE_NORTH_MINI_CODE_FREE,
    );
}

export function getSmallOpenRouterModel(): OPENROUTER_MODELS {
    return getOpenRouterModelFromEnv(
        'OPENROUTER_SMALL_MODEL',
        OPENROUTER_MODELS.COHERE_NORTH_MINI_CODE_FREE,
    );
}

export function isOpenAICompatibleProviderConfigured(): boolean {
    return Boolean(process.env.OPENAI_COMPATIBLE_BASE_URL);
}

function getOpenAICompatibleModelFromEnv(name: string, fallback?: string): string {
    const value = process.env[name] ?? fallback;
    if (!value) {
        throw new Error(`${name} must be set when OPENAI_COMPATIBLE_BASE_URL is configured`);
    }
    return value;
}

export function getDefaultModelPayload(): InitialModelPayload {
    if (isOpenAICompatibleProviderConfigured()) {
        return {
            provider: LLMProvider.OPENAI_COMPATIBLE,
            model: getOpenAICompatibleModelFromEnv('OPENAI_COMPATIBLE_MODEL'),
        };
    }

    return {
        provider: LLMProvider.OPENROUTER,
        model: getDefaultOpenRouterModel(),
    };
}

export function getSmallModelPayload(): InitialModelPayload {
    if (isOpenAICompatibleProviderConfigured()) {
        return {
            provider: LLMProvider.OPENAI_COMPATIBLE,
            model: getOpenAICompatibleModelFromEnv(
                'OPENAI_COMPATIBLE_SMALL_MODEL',
                process.env.OPENAI_COMPATIBLE_MODEL,
            ),
        };
    }

    return {
        provider: LLMProvider.OPENROUTER,
        model: getSmallOpenRouterModel(),
    };
}
