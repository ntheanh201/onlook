import { api } from '@/trpc/server';
import { trackEvent } from '@/utils/analytics/server';
import {
    convertToStreamMessages,
    createRootAgentStream,
    getAskModeSystemPrompt,
    getCreatePageSystemPrompt,
    getDefaultOpenRouterModel,
    getSystemPrompt,
    initModel,
} from '@onlook/ai';
import { toDbMessage } from '@onlook/db';
import { ChatType, LLMProvider, type ChatMessage, type ChatMetadata } from '@onlook/models';
import { createUIMessageStream, createUIMessageStreamResponse, generateText } from 'ai';
import { type NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { checkMessageLimit, decrementUsage, errorHandler, getSupabaseUser, incrementUsage } from './helpers';

export async function POST(req: NextRequest) {
    try {
        const user = await getSupabaseUser(req);
        if (!user) {
            return new Response(JSON.stringify({
                error: 'Unauthorized, no user found. Please login again.',
                code: 401
            }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (!shouldUseSelfHostedChatProvider()) {
            const usageCheckResult = await checkMessageLimit(req);
            if (usageCheckResult.exceeded) {
                trackEvent({
                    distinctId: user.id,
                    event: 'message_limit_exceeded',
                    properties: {
                        usage: usageCheckResult.usage,
                    },
                });
                return new Response(JSON.stringify({
                    error: 'Message limit exceeded. Please upgrade to a paid plan.',
                    code: 402,
                    usage: usageCheckResult.usage,
                }), {
                    status: 402,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        return streamResponse(req, user.id);
    } catch (error: unknown) {
        console.error('Error in chat', error);
        return new Response(JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            code: 500,
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

export const streamResponse = async (req: NextRequest, userId: string) => {
    const body = await req.json();
    const { messages, chatType, conversationId, projectId } = body as {
        messages: ChatMessage[],
        chatType: ChatType,
        conversationId: string,
        projectId: string,
    };
    // Updating the usage record and rate limit is done here to avoid
    // abuse in the case where a single user sends many concurrent requests.
    // If the call below fails, the user will not be penalized.
    let usageRecord: {
        usageRecordId: string | undefined;
        rateLimitId: string | undefined;
    } | null = null;

    try {
        const lastUserMessage = messages.findLast((message) => message.role === 'user');
        const traceId = lastUserMessage?.id ?? uuidv4();
        const useSelfHostedChatProvider = shouldUseSelfHostedChatProvider();

        if (chatType === ChatType.EDIT && !useSelfHostedChatProvider) {
            usageRecord = await incrementUsage(req, traceId);
        }
        if (useSelfHostedChatProvider) {
            return createPlainTextFallbackResponse({
                messages,
                conversationId,
                chatType,
            });
        }
        const stream = createRootAgentStream({
            chatType,
            conversationId,
            projectId,
            userId,
            traceId,
            messages,
        });
        return stream.toUIMessageStreamResponse<ChatMessage>(
            {
                originalMessages: messages,
                generateMessageId: () => uuidv4(),
                messageMetadata: ({ part }) => {
                    return {
                        createdAt: new Date(),
                        conversationId,
                        context: [],
                        checkpoints: [],
                        finishReason: part.type === 'finish-step' ? part.finishReason : undefined,
                        usage: part.type === 'finish-step' ? part.usage : undefined,
                    } satisfies ChatMetadata;
                },
                onFinish: async ({ messages: finalMessages }) => {
                    const messagesToStore = finalMessages
                        .filter(msg =>
                            (msg.role === 'user' || msg.role === 'assistant')
                        )
                        .map(msg => toDbMessage(msg, conversationId));

                    await api.chat.message.replaceConversationMessages({
                        conversationId,
                        messages: messagesToStore,
                    });
                },
                onError: errorHandler,
            }
        );
    } catch (error) {
        console.error('Error in streamResponse setup', error);
        if (isSuccessfulResponseProcessingError(error)) {
            return createPlainTextFallbackResponse({
                messages,
                conversationId,
                chatType,
            });
        }
        // If there was an error setting up the stream and we incremented usage, revert it
        if (usageRecord) {
            await decrementUsage(req, usageRecord);
        }
        throw error;
    }
}

function isSuccessfulResponseProcessingError(error: unknown) {
    return error instanceof Error && error.message.includes('Failed to process successful response');
}

async function createPlainTextFallbackResponse({
    messages,
    conversationId,
    chatType,
}: {
    messages: ChatMessage[];
    conversationId: string;
    chatType: ChatType;
}) {
    const id = uuidv4();
    const metadata = {
        createdAt: new Date(),
        conversationId,
        context: [],
        checkpoints: [],
        finishReason: 'stop',
    } satisfies ChatMetadata;

    const text = await generateFallbackText({
        messages,
        chatType,
    });
    const assistantMessage = {
        id,
        role: 'assistant',
        metadata,
        parts: [{ type: 'text', text, state: 'done' }],
    } satisfies ChatMessage;
    const finalMessages = [...messages, assistantMessage];
    const messagesToStore = finalMessages
        .filter(msg => msg.role === 'user' || msg.role === 'assistant')
        .map(msg => toDbMessage(msg, conversationId));

    await api.chat.message.replaceConversationMessages({
        conversationId,
        messages: messagesToStore,
    });

    const stream = createUIMessageStream<ChatMessage>({
        originalMessages: messages,
        generateId: () => id,
        execute: ({ writer }) => {
            writer.write({ type: 'start', messageId: id, messageMetadata: metadata });
            writer.write({ type: 'start-step' });
            writer.write({ type: 'text-start', id });
            writer.write({ type: 'text-delta', id, delta: text });
            writer.write({ type: 'text-end', id });
            writer.write({ type: 'finish-step' });
            writer.write({ type: 'finish', messageMetadata: metadata });
        },
        onError: errorHandler,
    });

    return createUIMessageStreamResponse({ stream });
}

async function generateFallbackText({
    messages,
    chatType,
}: {
    messages: ChatMessage[];
    chatType: ChatType;
}) {
    const codexText = await generateCodexLocalText({ messages, chatType });
    if (codexText) {
        return codexText;
    }

    try {
        const { model, providerOptions, headers, maxRetries } = initModel({
            provider: LLMProvider.OPENROUTER,
            model: getDefaultOpenRouterModel(),
        });
        const result = await generateText({
            model,
            headers,
            providerOptions,
            maxRetries,
            messages: convertToStreamMessages(messages),
            system: getFallbackSystemPrompt(chatType),
            maxOutputTokens: 1000,
        });
        return result.text;
    } catch (error) {
        console.error('Error in OpenRouter fallback chat', error);
        return getOpenRouterErrorMessage(error);
    }
}

function getOpenRouterErrorMessage(error: unknown) {
    const responseBody = typeof error === 'object' && error && 'responseBody' in error
        ? (error as { responseBody?: unknown }).responseBody
        : undefined;
    if (typeof responseBody === 'string') {
        try {
            const parsed = JSON.parse(responseBody) as { error?: { message?: string } };
            const message = parsed.error?.message;
            if (message?.includes('free-models-per-day')) {
                return `${message}. OpenRouter free models are exhausted for this key today. Add credits in OpenRouter, wait for the daily reset, or set OPENROUTER_MODEL to a paid model.`;
            }
            if (message) {
                return message;
            }
        } catch {
            return responseBody;
        }
    }
    return error instanceof Error ? error.message : String(error);
}

async function generateCodexLocalText({
    messages,
    chatType,
}: {
    messages: ChatMessage[];
    chatType: ChatType;
}) {
    const bridgeUrl = process.env.CODEX_LOCAL_BRIDGE_URL;
    if (!bridgeUrl) {
        return null;
    }

    try {
        const response = await fetch(new URL('/chat', bridgeUrl), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                prompt: buildCodexPrompt({ messages, chatType }),
            }),
        });
        const body = await response.json() as { text?: string; error?: string };
        if (!response.ok) {
            return `Local Codex bridge error: ${body.error ?? response.statusText}`;
        }
        return body.text?.trim() || 'Local Codex returned an empty response.';
    } catch (error) {
        console.error('Error calling local Codex bridge', error);
        return `Local Codex bridge error: ${error instanceof Error ? error.message : String(error)}`;
    }
}

function buildCodexPrompt({
    messages,
    chatType,
}: {
    messages: ChatMessage[];
    chatType: ChatType;
}) {
    const transcript = messages
        .map(message => {
            const text = message.parts
                .map(part => part.type === 'text' ? part.text : '')
                .join('')
                .trim();
            return text ? `${message.role}: ${text}` : '';
        })
        .filter(Boolean)
        .join('\n\n');

    return [
        `You are powering Onlook's ${chatType} chat mode for a local self-hosted project.`,
        'Answer concisely and focus on practical Next.js/React UI work.',
        'Do not modify files from this chat response. If code changes are needed, describe the exact files and changes.',
        '',
        transcript,
    ].join('\n');
}

function shouldUseSelfHostedChatProvider() {
    return Boolean(process.env.CODEX_LOCAL_BRIDGE_URL) || shouldUsePlainTextOpenRouterFallback();
}

function shouldUsePlainTextOpenRouterFallback() {
    return process.env.OPENROUTER_MODEL?.endsWith(':free') ?? false;
}

function getFallbackSystemPrompt(chatType: ChatType) {
    switch (chatType) {
        case ChatType.CREATE:
            return getCreatePageSystemPrompt();
        case ChatType.ASK:
            return getAskModeSystemPrompt();
        case ChatType.EDIT:
        case ChatType.FIX:
        default:
            return getSystemPrompt();
    }
}
