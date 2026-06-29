'use server';

import { env } from '@/env';
import { Routes } from '@/utils/constants';
import { getAuthenticatedUser } from '@/utils/supabase/auth';
import { createClient } from '@/utils/supabase/server';
import { SEED_USER } from '@onlook/db';
import { SignInMethod } from '@onlook/models';

export async function login(provider: SignInMethod.GITHUB | SignInMethod.GOOGLE) {
    const supabase = await createClient();
    const redirectTo = `${env.NEXT_PUBLIC_SITE_URL}${Routes.AUTH_CALLBACK}`;

    // If the cookie points at a deleted local Supabase user, getSession() still
    // returns a JWT. Validate it before deciding the user is already signed in.
    const { user, error: userError } = await getAuthenticatedUser(supabase);
    if (user) {
        return Routes.AUTH_REDIRECT;
    }
    if (userError) {
        await supabase.auth.signOut({ scope: 'local' });
    }

    // Start OAuth flow
    // Note: User object will be created in the auth callback route if it doesn't exist
    const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
            redirectTo,
        },
    });

    if (error) {
        throw new Error(error.message);
    }

    return data.url;
}

export async function devLogin() {
    if (env.NODE_ENV !== 'development') {
        throw new Error('Dev login is only available in development mode');
    }

    const supabase = await createClient();
    const { user, error: userError } = await getAuthenticatedUser(supabase);

    if (user) {
        return Routes.AUTH_REDIRECT;
    }
    if (userError) {
        await supabase.auth.signOut({ scope: 'local' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
        email: SEED_USER.EMAIL,
        password: SEED_USER.PASSWORD,
    });

    if (error) {
        console.error('Error signing in with password:', error);
        throw new Error(error.message);
    }
    return Routes.AUTH_REDIRECT;
}
