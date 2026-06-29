import { users, type DrizzleDb } from '@onlook/db';
import {
    createInstallationAccessToken,
    createInstallationOctokit,
    generateInstallationUrl,
    githubApiRequest
} from '@onlook/github';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../trpc';

const getUserGitHubInstallation = async (db: DrizzleDb, userId: string) => {
    const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { githubInstallationId: true }
    });

    if (!user?.githubInstallationId) {
        throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'GitHub App installation required',
        });
    }
    return {
        octokit: createInstallationOctokit(user.githubInstallationId),
        installationId: user.githubInstallationId
    };
};

type GitHubInstallationRepository = {
    id: number;
    name: string;
    full_name: string;
    description: string | null;
    private: boolean;
    default_branch: string;
    clone_url: string;
    html_url: string;
    updated_at: string;
    owner: {
        login: string;
        avatar_url: string;
    };
};

const fetchInstallationRepositories = async (installationId: string) => {
    const token = await createInstallationAccessToken(installationId);
    const repositories: GitHubInstallationRepository[] = [];
    const perPage = 100;

    for (let page = 1; ; page++) {
        const data = await githubApiRequest<{ repositories?: GitHubInstallationRepository[] }>(
            `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`,
            {
                token,
            },
        );

        const pageRepositories = data.repositories ?? [];
        repositories.push(...pageRepositories);

        if (pageRepositories.length < perPage) {
            return repositories;
        }
    }
};

export const githubRouter = createTRPCRouter({
    validate: protectedProcedure
        .input(
            z.object({
                owner: z.string(),
                repo: z.string()
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const { octokit } = await getUserGitHubInstallation(ctx.db, ctx.user.id);
            const { data } = await octokit.rest.repos.get({ owner: input.owner, repo: input.repo });
            return {
                branch: data.default_branch,
                isPrivateRepo: data.private
            };
        }),
    getRepo: protectedProcedure
        .input(
            z.object({
                owner: z.string(),
                repo: z.string()
            }),
        )
        .query(async ({ input, ctx }) => {
            const { octokit } = await getUserGitHubInstallation(ctx.db, ctx.user.id);
            const { data } = await octokit.rest.repos.get({
                owner: input.owner,
                repo: input.repo
            });
            return data;
        }),

    getOrganizations: protectedProcedure
        .query(async ({ ctx }) => {
            try {
                const { octokit, installationId } = await getUserGitHubInstallation(ctx.db, ctx.user.id);

                // Get installation details to determine account type
                const installation = await octokit.rest.apps.getInstallation({
                    installation_id: parseInt(installationId, 10),
                });

                // If installed on an organization, return that organization
                if (installation.data.account && 'type' in installation.data.account && installation.data.account.type === 'Organization') {
                    return [{
                        id: installation.data.account.id,
                        login: 'login' in installation.data.account ? installation.data.account.login : (installation.data.account as any).name || '',
                        avatar_url: installation.data.account.avatar_url,
                        description: undefined, // Organizations don't have descriptions in this context
                    }];
                }

                // If installed on a user account, return empty (no organizations)
                return [];
            } catch (error) {
                console.error('Error fetching GitHub organizations:', error);
                throw new TRPCError({
                    code: 'FORBIDDEN',
                    message: 'GitHub App installation is invalid or has been revoked',
                    cause: error
                });
            }
        }),
    getRepoFiles: protectedProcedure
        .input(
            z.object({
                owner: z.string(),
                repo: z.string(),
                path: z.string().default(''),
                ref: z.string().optional() // branch, tag, or commit SHA
            })
        )
        .query(async ({ input, ctx }) => {
            const { octokit } = await getUserGitHubInstallation(ctx.db, ctx.user.id);
            const { data } = await octokit.rest.repos.getContent({
                owner: input.owner,
                repo: input.repo,
                path: input.path,
                ...(input.ref && { ref: input.ref })
            });
            return data;
        }),
    generateInstallationUrl: protectedProcedure
        .input(
            z.object({
                redirectUrl: z.string().optional(),
            }).optional()
        )
        .mutation(async ({ input, ctx }) => {
            const { url, state } = generateInstallationUrl({
                redirectUrl: input?.redirectUrl,
                state: ctx.user.id, // Use user ID as state for CSRF protection
            });

            return { url, state };
        }),

    checkGitHubAppInstallation: protectedProcedure
        .query(async ({ ctx }): Promise<string | null> => {
            try {
                const { octokit, installationId } = await getUserGitHubInstallation(ctx.db, ctx.user.id);
                await octokit.rest.apps.getInstallation({
                    installation_id: parseInt(installationId, 10),
                });
                return installationId;
            } catch (error) {
                console.error('Error checking GitHub App installation:', error);
                throw new TRPCError({
                    code: 'FORBIDDEN',
                    message: error instanceof Error ? error.message : 'GitHub App installation is invalid or has been revoked',
                    cause: error
                });
            }
        }),

    // Repository fetching using GitHub App installation (required)
    getRepositoriesWithApp: protectedProcedure
        .input(
            z.object({
                username: z.string().optional(),
            }).optional()
        )
        .query(async ({ ctx }) => {
            try {
                const { installationId } = await getUserGitHubInstallation(ctx.db, ctx.user.id);

                const repositories = await fetchInstallationRepositories(installationId);

                // Transform to match reference implementation pattern
                return repositories.map(repo => ({
                    id: repo.id,
                    name: repo.name,
                    full_name: repo.full_name,
                    description: repo.description,
                    private: repo.private,
                    default_branch: repo.default_branch,
                    clone_url: repo.clone_url,
                    html_url: repo.html_url,
                    updated_at: repo.updated_at,
                    owner: {
                        login: repo.owner.login,
                        avatar_url: repo.owner.avatar_url,
                    },
                }));
            } catch (error) {
                console.error('Error fetching GitHub repositories:', error);
                throw new TRPCError({
                    code: 'FORBIDDEN',
                    message: 'GitHub App installation is invalid or has been revoked. Please reinstall the GitHub App.',
                    cause: error
                });
            }
        }),
    handleInstallationCallbackUrl: protectedProcedure
        .input(
            z.object({
                installationId: z.string(),
                setupAction: z.string(),
                state: z.string(),
            })
        )
        .mutation(async ({ input, ctx }) => {
            // Validate state parameter matches current user ID for CSRF protection
            if (input.state && input.state !== ctx.user.id) {
                console.error('State mismatch:', { expected: ctx.user.id, received: input.state });
                throw new TRPCError({
                    code: 'BAD_REQUEST',
                    message: 'Invalid state parameter',
                });
            }

            // Update user's GitHub installation ID
            try {
                await ctx.db.update(users)
                    .set({ githubInstallationId: input.installationId })
                    .where(eq(users.id, ctx.user.id));

                console.log(`Updated installation ID for user: ${ctx.user.id}`);

                return {
                    success: true,
                    message: 'GitHub App installation completed successfully',
                    installationId: input.installationId,
                };

            } catch (error) {
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to update GitHub installation',
                    cause: error,
                });
            }
        }),

});
