import { Routes } from '@/utils/constants';
import { getAuthenticatedUser } from '@/utils/supabase/auth';
import { createClient } from '@/utils/supabase/server';
import { type Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
    title: 'Onlook',
    description: 'Onlook – Create Project',
};

export default async function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
    const supabase = await createClient();
    const { user } = await getAuthenticatedUser(supabase);
    if (!user) {
        redirect(Routes.LOGIN);
    }
    return <>{children}</>;
}
