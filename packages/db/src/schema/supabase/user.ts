import { jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const authSchema = pgSchema('auth');

export const authUsers = authSchema.table('users', {
    id: uuid('id').primaryKey(),
    aud: text('aud'),
    role: text('role'),
    email: text('email').notNull(),
    phone: text('phone'),
    emailConfirmedAt: timestamp('email_confirmed_at', { withTimezone: true }),
    phoneConfirmedAt: timestamp('phone_confirmed_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    rawAppMetaData: jsonb('raw_app_meta_data'),
    rawUserMetaData: jsonb('raw_user_meta_data'),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
});

export type AuthUser = typeof authUsers.$inferSelect;
