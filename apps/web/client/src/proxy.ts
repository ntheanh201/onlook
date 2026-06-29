import { updateSession } from '@/utils/supabase/middleware';
import { env } from '@/env';
import { NextResponse, type NextRequest } from 'next/server';

export async function proxy(request: NextRequest) {
    const host = request.headers.get('host') ?? '';
    if (host === '0.0.0.0' || host.startsWith('0.0.0.0:')) {
        const url = new URL(request.nextUrl.pathname + request.nextUrl.search, env.NEXT_PUBLIC_SITE_URL);
        return NextResponse.redirect(url);
    }

    // update user's auth session
    return await updateSession(request);
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         * Feel free to modify this pattern to include more paths.
         */
        '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ],
};
