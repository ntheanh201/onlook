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

        if (chatType === ChatType.EDIT) {
            usageRecord = await incrementUsage(req, traceId);
        }
        if (shouldUsePlainTextOpenRouterFallback()) {
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
    const assistantMessage = {
        id,
        role: 'assistant',
        metadata,
        parts: [{ type: 'text', text: result.text, state: 'done' }],
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
            writer.write({ type: 'text-delta', id, delta: result.text });
            writer.write({ type: 'text-end', id });
            writer.write({ type: 'finish-step' });
            writer.write({ type: 'finish', messageMetadata: metadata });
        },
        onError: errorHandler,
    });

    return createUIMessageStreamResponse({ stream });
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
