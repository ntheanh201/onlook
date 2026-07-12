import { getSmallModelPayload, initModel, SUGGESTION_SYSTEM_PROMPT } from '@onlook/ai';
import { conversations } from '@onlook/db';
import type { ChatSuggestion } from '@onlook/models';
import { ChatSuggestionsSchema } from '@onlook/models/chat';
import { convertToModelMessages, generateObject } from 'ai';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../../trpc';

export const suggestionsRouter = createTRPCRouter({
    generate: protectedProcedure
        .input(z.object({
            conversationId: z.string(),
            messages: z.array(z.object({
                role: z.enum(['user', 'assistant', 'system']),
                content: z.string(),
            })),
        }))
        .mutation(async ({ ctx, input }) => {
            let suggestions: ChatSuggestion[] = [];
            try {
                const { model, headers, maxRetries } = initModel(getSmallModelPayload());
                const { object } = await generateObject({
                    model,
                    headers,
                    maxRetries,
                    schema: ChatSuggestionsSchema,
                    messages: [
                        {
                            role: 'system',
                            content: SUGGESTION_SYSTEM_PROMPT,
                        },
                        ...convertToModelMessages(input.messages.map((m) => ({
                            role: m.role,
                            parts: [{ type: 'text', text: m.content }],
                        }))),
                        {
                            role: 'user',
                            content: 'Based on our conversation, what should I work on next to improve this page? Provide 3 specific, actionable suggestions. These should be realistic and achievable. Return the suggestions as a JSON object. DO NOT include any other text.',
                        },
                    ],
                    maxOutputTokens: 1000,
                });
                suggestions = object.suggestions satisfies ChatSuggestion[];
            } catch (error) {
                console.warn('Error generating chat suggestions:', error);
            }
            try {
                await ctx.db.update(conversations).set({
                    suggestions,
                }).where(eq(conversations.id, input.conversationId));
            } catch (error) {
                console.error('Error updating conversation suggestions:', error);
            }
            return suggestions;
        }),
});
