import { Routes } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';
import { generateInstallationUrl } from '@onlook/github';
import { NextResponse, type NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
    const requestUrl = new URL(request.url);
    const origin = requestUrl.origin;
    const supabase = await createClient();
    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();

    if (error || !user) {
        return NextResponse.redirect(
            `${origin}${Routes.LOGIN}?returnUrl=${encodeURIComponent(Routes.IMPORT_GITHUB)}`,
        );
    }

    try {
        const { url } = generateInstallationUrl({
            state: user.id,
            redirectUrl: requestUrl.searchParams.get('redirectUrl') ?? `${origin}${Routes.CALLBACK_GITHUB_INSTALL}`,
        });

        return NextResponse.redirect(url);
    } catch (error) {
        console.error('Error generating GitHub App installation URL:', error);
        return NextResponse.json(
            { error: 'Failed to generate GitHub App installation URL' },
            { status: 500 },
        );
    }
}
