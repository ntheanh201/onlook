import { exec, execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { env } from '@/env';
import { z } from 'zod';

const pexec = promisify(exec);
const pexecFile = promisify(execFile);
const PREVIEW_DIR =
    process.env.LOCAL_PREVIEW_DIR ?? path.resolve(process.cwd(), '../../..', 'local-preview');
const MAX_BUFFER = 20 * 1024 * 1024;
const gitEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: PREVIEW_DIR,
};

const requestSchema = z.object({
    action: z.enum(['run', 'status']),
    command: z.string().optional(),
});

export async function POST(req: Request) {
    if (!env.NEXT_PUBLIC_LOCAL_PREVIEW_ONLY) {
        return Response.json({ error: 'Local preview mode is disabled' }, { status: 400 });
    }

    const { action, command } = requestSchema.parse(await req.json());

    if (action === 'status') {
        try {
            const { stdout } = await pexecFile(
                'git',
                ['status', '--porcelain=v1', '-z', '-uall'],
                {
                    cwd: PREVIEW_DIR,
                    env: gitEnv,
                    maxBuffer: MAX_BUFFER,
                },
            );
            return Response.json({ raw: stdout });
        } catch {
            return Response.json({ raw: '' });
        }
    }

    if (!command || !/^git(\s|$)/.test(command.trim())) {
        return Response.json({ error: 'Only git commands are permitted' }, { status: 400 });
    }

    try {
        const { stdout, stderr } = await pexec(command, {
            cwd: PREVIEW_DIR,
            env: gitEnv,
            maxBuffer: MAX_BUFFER,
        });
        return Response.json({ output: `${stdout ?? ''}${stderr ?? ''}` });
    } catch (error: unknown) {
        const err = error as { stdout?: string; stderr?: string; message?: string };
        return Response.json({
            output: `${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`,
        });
    }
}
