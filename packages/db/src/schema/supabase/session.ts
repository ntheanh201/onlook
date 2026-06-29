import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { authSchema, authUsers } from './user';

export const authSessions = authSchema.table('sessions', {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
        .notNull()
        .references(() => authUsers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    notAfter: timestamp('not_after', { withTimezone: true }),
    refreshedAt: timestamp('refreshed_at'),
});

export type AuthSession = typeof authSessions.$inferSelect;
