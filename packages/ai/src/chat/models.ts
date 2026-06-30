import { OPENROUTER_MODELS } from '@onlook/models';

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
