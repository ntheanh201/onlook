import { env } from '@/env';
import { trackEvent } from '@/utils/analytics/server';
import { Routes } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';
import { users } from '@onlook/db';
import { db } from '@onlook/db/src/client';
import { extractNames } from '@onlook/utility';
import { NextResponse, type NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const origin = env.NEXT_PUBLIC_SITE_URL;

    if (code) {
        const supabase = await createClient();
        const { error, data } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) {
            const displayName = data.user.user_metadata.name
                ?? data.user.user_metadata.display_name
                ?? data.user.user_metadata.full_name
                ?? data.user.user_metadata.first_name
                ?? data.user.user_metadata.last_name
                ?? '';
            const { firstName, lastName } = extractNames(displayName);
            const userData = {
                id: data.user.id,
                firstName,
                lastName,
                displayName,
                email: data.user.email,
                avatarUrl: data.user.user_metadata.avatar_url,
            };

            const [user] = await db
                .insert(users)
                .values(userData)
                .onConflictDoUpdate({
                    target: [users.id],
                    set: {
                        ...userData,
                        updatedAt: new Date(),
                    },
                })
                .returning();

            if (!user) {
                console.error(`Failed to create user for id: ${data.user.id}`, { user });
                return NextResponse.redirect(`${origin}/auth/auth-code-error`);
            }

            trackEvent({
                distinctId: data.user.id,
                event: 'user_signed_in',
                properties: {
                    name: data.user.user_metadata.name,
                    email: data.user.email,
                    avatar_url: data.user.user_metadata.avatar_url,
                    $set_once: {
                        signup_date: new Date().toISOString(),
                    }
                }
            });

            return NextResponse.redirect(`${origin}${Routes.AUTH_REDIRECT}`);
        }
        console.error(`Error exchanging code for session: ${error}`);
    }

    // return the user to an error page with instructions
    return NextResponse.redirect(`${origin}/auth/auth-code-error`);
}
