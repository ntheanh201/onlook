import 'server-only';

import { env } from '@/env';
import { SEED_USER, authUsers } from '@onlook/db';
import { db } from '@onlook/db/src/client';
import type { Session, User } from '@supabase/supabase-js';
import { eq, sql } from 'drizzle-orm';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';

type SupabaseUserClient = {
    auth: {
        getUser: () => Promise<{
            data: { user: User | null };
            error: { message: string } | null;
        }>;
    };
};

export async function getAuthenticatedUser(
    supabase: SupabaseUserClient,
    req?: NextRequest,
): Promise<{ user: User | null; error: string | null }> {
    if (env.NEXT_PUBLIC_LOCAL_PREVIEW_ONLY) {
        return { user: getLocalPreviewUser(), error: null };
    }

    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();

    if (!error) {
        return { user, error: null };
    }

    const fallback = await getUserFromVerifiedCookie(error.message, req);
    if (fallback.user) {
        return fallback;
    }

    return { user: null, error: fallback.error ?? error.message };
}

function getLocalPreviewUser(): User {
    const now = new Date().toISOString();

    return {
        id: SEED_USER.ID,
        app_metadata: {},
        aud: 'authenticated',
        created_at: now,
        email: SEED_USER.EMAIL,
        email_confirmed_at: now,
        phone: '',
        phone_confirmed_at: '',
        confirmed_at: now,
        role: 'authenticated',
        updated_at: now,
        user_metadata: {
            avatar_url: SEED_USER.AVATAR_URL,
            display_name: SEED_USER.DISPLAY_NAME,
            first_name: SEED_USER.FIRST_NAME,
            last_name: SEED_USER.LAST_NAME,
        },
    };
}

async function getUserFromVerifiedCookie(
    authError: string,
    req?: NextRequest,
): Promise<{ user: User | null; error: string | null }> {
    if (!shouldUseLocalAuthFallback(authError)) {
        return { user: null, error: authError };
    }

    const jwtSecret = getSupabaseJwtSecret();
    if (!jwtSecret) {
        return { user: null, error: authError };
    }

    const accessToken = req
        ? getAccessTokenFromRequest(req)
        : await getAccessTokenFromServerCookies();
    if (!accessToken) {
        return { user: null, error: authError };
    }

    return getUserFromLocalJwt(accessToken, jwtSecret);
}

function shouldUseLocalAuthFallback(error: string) {
    return error.includes('JSON Parse error: Unexpected EOF');
}

async function getUserFromLocalJwt(
    accessToken: string,
    jwtSecret: string,
): Promise<{ user: User | null; error: string | null }> {
    const payload = verifySupabaseJwt(accessToken, jwtSecret);
    if (!isSupabaseJwtPayload(payload)) {
        return { user: null, error: 'Invalid auth token' };
    }

    if (payload.exp * 1000 <= Date.now()) {
        return { user: null, error: 'Auth session expired' };
    }

    const authUser = await db.query.authUsers.findFirst({
        where: eq(authUsers.id, payload.sub),
    });

    if (!authUser) {
        return { user: null, error: 'Auth session missing!' };
    }

    if (!payload.session_id || !(await hasValidAuthSession(payload.session_id, payload.sub))) {
        return { user: null, error: 'Auth session missing!' };
    }

    const authUserRecord = authUser as typeof authUser & {
        aud?: string | null;
        confirmedAt?: Date | null;
        createdAt?: Date | null;
        phone?: string | null;
        phoneConfirmedAt?: Date | null;
        rawAppMetaData?: unknown;
        role?: string | null;
        updatedAt?: Date | null;
    };
    const emailConfirmedAt = authUser.emailConfirmedAt?.toISOString();
    const phoneConfirmedAt = authUserRecord.phoneConfirmedAt?.toISOString();

    return {
        user: {
            id: payload.sub,
            app_metadata: normalizeUserMetadata(authUserRecord.rawAppMetaData) || payload.app_metadata || {},
            aud: authUserRecord.aud ?? payload.aud,
            created_at: authUserRecord.createdAt?.toISOString() ?? '',
            email: authUser.email,
            email_confirmed_at: emailConfirmedAt,
            phone: authUserRecord.phone ?? '',
            phone_confirmed_at: phoneConfirmedAt,
            confirmed_at: authUserRecord.confirmedAt?.toISOString() ?? emailConfirmedAt ?? phoneConfirmedAt,
            role: authUserRecord.role ?? payload.role,
            updated_at: authUserRecord.updatedAt?.toISOString() ?? '',
            user_metadata: normalizeUserMetadata(authUser.rawUserMetaData) ?? {},
        },
        error: null,
    };
}

async function hasValidAuthSession(sessionId: string, userId: string): Promise<boolean> {
    const result = await db.execute(sql`
        select 1
        from auth.sessions
        where id = ${sessionId}
          and user_id = ${userId}
          and (not_after is null or not_after > now())
        limit 1
    `);

    if (Array.isArray(result)) {
        return result.length > 0;
    }

    return Boolean((result as { rows?: unknown[] }).rows?.length);
}

function verifySupabaseJwt(accessToken: string, jwtSecret: string): unknown {
    try {
        const [headerPart, payloadPart, signaturePart] = accessToken.split('.');
        if (!headerPart || !payloadPart || !signaturePart) {
            return null;
        }

        const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as {
            alg?: string;
        };
        if (header.alg !== 'HS256') {
            return null;
        }

        const expectedSignature = createHmac('sha256', jwtSecret)
            .update(`${headerPart}.${payloadPart}`)
            .digest();
        const actualSignature = Buffer.from(signaturePart, 'base64url');
        if (
            expectedSignature.length !== actualSignature.length ||
            !timingSafeEqual(expectedSignature, actualSignature)
        ) {
            return null;
        }

        return JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

function getSupabaseJwtSecret() {
    if (env.SUPABASE_JWT_SECRET) {
        return env.SUPABASE_JWT_SECRET;
    }

    const hostname = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname;
    if (hostname === '127.0.0.1' || hostname === 'localhost') {
        return 'super-secret-jwt-token-with-at-least-32-characters-long';
    }

    return null;
}

function isSupabaseJwtPayload(payload: unknown): payload is {
    aud: string;
    exp: number;
    role: string;
    sub: string;
    session_id?: string;
    app_metadata?: Record<string, unknown>;
} {
    return (
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as { aud?: unknown }).aud === 'string' &&
        typeof (payload as { exp?: unknown }).exp === 'number' &&
        typeof (payload as { role?: unknown }).role === 'string' &&
        typeof (payload as { sub?: unknown }).sub === 'string' &&
        (
            typeof (payload as { session_id?: unknown }).session_id === 'undefined' ||
            typeof (payload as { session_id?: unknown }).session_id === 'string'
        )
    );
}

function normalizeUserMetadata(metadata: unknown): Record<string, unknown> | null {
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
        return metadata as Record<string, unknown>;
    }
    return null;
}

async function getAccessTokenFromServerCookies(): Promise<string | null> {
    const cookieStore = await cookies();
    const cookieName = getSupabaseAuthCookieName();
    const baseCookie = cookieStore.get(cookieName)?.value;
    if (baseCookie) {
        return getAccessTokenFromCookieValue(baseCookie);
    }

    const chunks: string[] = [];
    for (let i = 0; ; i++) {
        const chunk = cookieStore.get(`${cookieName}.${i}`)?.value;
        if (!chunk) {
            break;
        }
        chunks.push(chunk);
    }

    return chunks.length ? getAccessTokenFromCookieValue(chunks.join('')) : null;
}

function getAccessTokenFromRequest(req: NextRequest): string | null {
    const cookieName = getSupabaseAuthCookieName();
    const cookieValue = combineCookieChunks(req, cookieName);
    return cookieValue ? getAccessTokenFromCookieValue(cookieValue) : null;
}

function getAccessTokenFromCookieValue(cookieValue: string): string | null {
    try {
        const session = JSON.parse(decodeSupabaseCookieValue(cookieValue)) as Partial<Session>;
        return typeof session.access_token === 'string' ? session.access_token : null;
    } catch (error) {
        console.error('Failed to parse Supabase auth cookie', error);
        return null;
    }
}

function getSupabaseAuthCookieName() {
    const hostname = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
    return `sb-${hostname}-auth-token`;
}

function combineCookieChunks(req: NextRequest, cookieName: string): string | null {
    const cookies = parseCookieHeader(req.headers.get('cookie') ?? '');
    const baseCookie = cookies.get(cookieName) ?? req.cookies.get(cookieName)?.value;
    if (baseCookie) {
        return baseCookie;
    }

    const chunks: string[] = [];
    for (let i = 0; ; i++) {
        const chunkName = `${cookieName}.${i}`;
        const chunk = cookies.get(chunkName) ?? req.cookies.get(chunkName)?.value;
        if (!chunk) {
            break;
        }
        chunks.push(chunk);
    }

    return chunks.length ? chunks.join('') : null;
}

function decodeSupabaseCookieValue(value: string): string {
    const base64Prefix = 'base64-';
    if (!value.startsWith(base64Prefix)) {
        return value;
    }
    return Buffer.from(value.slice(base64Prefix.length), 'base64url').toString('utf8');
}

function parseCookieHeader(cookieHeader: string): Map<string, string> {
    const cookies = new Map<string, string>();
    for (const part of cookieHeader.split(';')) {
        const separator = part.indexOf('=');
        if (separator === -1) {
            continue;
        }
        const name = part.slice(0, separator).trim();
        const rawValue = part.slice(separator + 1).trim();
        try {
            cookies.set(name, decodeURIComponent(rawValue));
        } catch {
            cookies.set(name, rawValue);
        }
    }
    return cookies;
}
