"use server";

import { env } from '@/env';
import { createClient as createSupabaseClient } from '@/utils/supabase/request-server';
import { authSessions, authUsers } from '@onlook/db';
import { db } from '@onlook/db/src/client';
import type { Session, User } from '@supabase/supabase-js';
import { createHydrationHelpers } from '@trpc/react-query/rsc';
import { TRPCError } from '@trpc/server';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cache } from 'react';
import { createCaller, type AppRouter } from '~/server/api/root';
import { createQueryClient } from './query-client';

export const createTRPCContext = async (req: NextRequest, opts: { headers: Headers }) => {
    const supabase = await createSupabaseClient(req);
    const { user, error } = await getUserFromSupabaseCookieClient(supabase);

    if (error) {
        const fallback = await getUserFromVerifiedCookie(req, error);
        if (!fallback.user) {
            throw new TRPCError({ code: 'UNAUTHORIZED', message: fallback.error ?? error });
        }

        return {
            db,
            supabase,
            user: fallback.user,
            ...opts,
        };
    }

    return {
        db,
        supabase,
        user,
        ...opts,
    };
};

const createContext = async (req: NextRequest) => {
    return createTRPCContext(
        req,
        { headers: req.headers },
    );
};


const getQueryClient = cache(createQueryClient);

/**
 * Used for API routes without using next headers lib
 */
export const createClient = async (req: NextRequest) => {
    const context = await createContext(req);
    const caller = createCaller(context);

    const { trpc: api, HydrateClient } = createHydrationHelpers<AppRouter>(
        caller,
        getQueryClient,
    );

    return { api, HydrateClient };
}

async function getUserFromSupabaseCookieClient(supabase: Awaited<ReturnType<typeof createSupabaseClient>>) {
    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();
    return { user, error: error?.message ?? null };
}

async function getUserFromVerifiedCookie(req: NextRequest, authError: string): Promise<{ user: User | null; error: string | null }> {
    if (!shouldUseLocalAuthFallback(authError)) {
        return { user: null, error: authError };
    }

    const jwtSecret = getSupabaseJwtSecret();
    if (!jwtSecret) {
        return { user: null, error: authError };
    }

    const accessToken = getAccessTokenFromRequest(req);
    if (!accessToken) {
        return { user: null, error: authError };
    }

    return getUserFromLocalJwt(accessToken, jwtSecret);
}

function shouldUseLocalAuthFallback(error: string) {
    return error.includes('JSON Parse error: Unexpected EOF');
}

async function getUserFromLocalJwt(accessToken: string, jwtSecret: string): Promise<{ user: User | null; error: string | null }> {
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

    const authSession = payload.session_id
        ? await db.query.authSessions.findFirst({
            where: and(
                eq(authSessions.id, payload.session_id),
                eq(authSessions.userId, payload.sub),
                or(isNull(authSessions.notAfter), gt(authSessions.notAfter, new Date())),
            ),
        })
        : null;

    if (!authSession) {
        return { user: null, error: 'Auth session missing!' };
    }

    const emailConfirmedAt = authUser.emailConfirmedAt?.toISOString();
    const phoneConfirmedAt = authUser.phoneConfirmedAt?.toISOString();

    return {
        user: {
            id: payload.sub,
            app_metadata: normalizeUserMetadata(authUser.rawAppMetaData) || payload.app_metadata || {},
            aud: authUser.aud ?? payload.aud,
            created_at: authUser.createdAt?.toISOString() ?? '',
            email: authUser.email,
            email_confirmed_at: emailConfirmedAt,
            phone: authUser.phone ?? '',
            phone_confirmed_at: phoneConfirmedAt,
            confirmed_at: authUser.confirmedAt?.toISOString() ?? emailConfirmedAt ?? phoneConfirmedAt,
            role: authUser.role ?? payload.role,
            updated_at: authUser.updatedAt?.toISOString() ?? '',
            user_metadata: normalizeUserMetadata(authUser.rawUserMetaData) ?? {},
        },
        error: null,
    };
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

function getAccessTokenFromRequest(req: NextRequest): string | null {
    const cookieName = getSupabaseAuthCookieName();
    const cookieValue = combineCookieChunks(req, cookieName);
    if (!cookieValue) {
        return null;
    }

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
