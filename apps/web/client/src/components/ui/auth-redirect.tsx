'use client';

import { LocalForageKeys, Routes } from '@/utils/constants';
import { createClient } from '@/utils/supabase/client';
import localforage from 'localforage';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export const AuthRedirect = ({ children }: { children: React.ReactNode }) => {
    const supabase = createClient();
    const router = useRouter();

    useEffect(() => {
        const getSession = async () => {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (!user) {
                await supabase.auth.signOut({ scope: 'local' });
                const pathname = window.location.pathname;
                await localforage.setItem(LocalForageKeys.RETURN_URL, pathname);
                router.push(Routes.LOGIN);
            }
        };
        getSession();
    }, [router]);
    return <>{children}</>;
};
