import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { createSign } from 'node:crypto';
import { request } from 'node:https';
import { getGitHubAppConfig } from './config';

type GitHubApiRequestOptions = {
    method?: string;
    token: string;
    body?: unknown;
};

/**
 * Create an authenticated Octokit instance for a specific installation
 */
export function createInstallationOctokit(installationId: string): Octokit {
    const config = getGitHubAppConfig();
    if (!installationId || installationId.trim() === '') {
        throw new Error('Installation ID is required and cannot be empty.');
    }

    return new Octokit({
        authStrategy: createAppAuth,
        auth: {
            appId: config.appId,
            privateKey: config.privateKey,
            installationId: parseInt(installationId, 10),
        },
    });
}

const base64Url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

const createGitHubAppJwt = (appId: string, privateKey: string) => {
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64Url(JSON.stringify({
        iat: now - 60,
        exp: now + 9 * 60,
        iss: appId,
    }));
    const signature = createSign('RSA-SHA256')
        .update(`${header}.${payload}`)
        .sign(privateKey, 'base64url');

    return `${header}.${payload}.${signature}`;
};

export async function githubApiRequest<T>(
    url: string,
    { method = 'GET', token, body }: GitHubApiRequestOptions,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const bodyText = body === undefined ? undefined : JSON.stringify(body);
        const parsedUrl = new URL(url);
        const req = request(
            {
                method,
                hostname: parsedUrl.hostname,
                path: `${parsedUrl.pathname}${parsedUrl.search}`,
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'onlook-self-hosted',
                    'X-GitHub-Api-Version': '2022-11-28',
                    ...(bodyText ? { 'Content-Length': Buffer.byteLength(bodyText) } : {}),
                },
            },
            (res) => {
                const chunks: Buffer[] = [];

                res.on('data', (chunk) => {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                });
                res.on('end', () => {
                    const responseText = Buffer.concat(chunks).toString('utf8');
                    if ((res.statusCode ?? 500) >= 400) {
                        reject(new Error(`GitHub API request failed (${res.statusCode}): ${responseText}`));
                        return;
                    }

                    try {
                        resolve((responseText ? JSON.parse(responseText) : null) as T);
                    } catch (error) {
                        reject(error);
                    }
                });
            },
        );

        req.on('error', reject);

        if (bodyText) {
            req.write(bodyText);
        }
        req.end();
    });
}

export async function createInstallationAccessToken(installationId: string): Promise<string> {
    const config = getGitHubAppConfig();
    if (!installationId || installationId.trim() === '') {
        throw new Error('Installation ID is required and cannot be empty.');
    }

    const appJwt = createGitHubAppJwt(config.appId, config.privateKey);
    const installationAuth = await githubApiRequest<{ token: string }>(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
            method: 'POST',
            token: appJwt,
        },
    );

    return installationAuth.token;
}
