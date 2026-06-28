'use client';

import { api } from '@/trpc/react';
import { useState } from 'react';

export interface GitHubAppInstallation {
    hasInstallation: boolean;
    installationId: string | null;
    isChecking: boolean;
    error: string | null;
    redirectToInstallation: (redirectUrl?: string) => Promise<void>;
    refetch: () => void;
    clearError: () => void;
}

export const useGitHubAppInstallation: () => GitHubAppInstallation = () => {
    const generateInstallationUrl = api.github.generateInstallationUrl.useMutation();
    const { data: installationId, refetch: checkInstallation, isFetching: isChecking } = api.github.checkGitHubAppInstallation.useQuery(undefined, {
        refetchOnWindowFocus: true,
        retry: false,
    });
    const [installError, setInstallError] = useState<string | null>(null);
    const hasInstallation = !!installationId;

    const clearError = () => {
        setInstallError(null);
    };

    const redirectToInstallation = async (redirectUrl?: string) => {
        clearError();
        try {
            const finalRedirectUrl = redirectUrl;
            const result = await generateInstallationUrl.mutateAsync({
                redirectUrl: finalRedirectUrl,
            });

            if (result?.url) {
                window.open(result.url, '_blank');
            }
        } catch (error) {
            console.error('Error generating GitHub App installation URL:', error);
            setInstallError(error instanceof Error ? error.message : 'Failed to generate GitHub App installation URL');
        }
    };

    return {
        hasInstallation,
        installationId: installationId || null,
        isChecking,
        error: installError,
        redirectToInstallation,
        refetch: checkInstallation,
        clearError,
    };
};
