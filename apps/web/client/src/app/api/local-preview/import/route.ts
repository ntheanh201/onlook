import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { env } from '@/env';
import { z } from 'zod';

const PREVIEW_DIR =
    process.env.LOCAL_PREVIEW_DIR ?? path.resolve(process.cwd(), '../../..', 'local-preview');
const PREVIEW_PORT = Number(process.env.LOCAL_PREVIEW_PORT ?? 3300);
const RESTART_MARKER = '.onlook-restart';

const fileSchema = z.object({
    path: z.string(),
    type: z.enum(['text', 'binary']),
    content: z.string(),
});

const importSchema = z.object({
    files: z.array(fileSchema).min(1),
});

function safePath(filePath: string) {
    const normalized = path.posix.normalize(filePath.replaceAll('\\', '/')).replace(/^\/+/, '');
    if (!normalized || normalized.startsWith('..') || normalized.includes('/../')) {
        throw new Error(`Invalid file path: ${filePath}`);
    }

    return path.join(PREVIEW_DIR, normalized);
}

function stripDevHostFlags(script: string) {
    return script
        .replace(/\s+--port(?:=|\s+)\d+/g, '')
        .replace(/\s+-p\s+\d+/g, '')
        .replace(/\s+--hostname(?:=|\s+)\S+/g, '')
        .replace(/\s+--host(?:=|\s+)\S+/g, '')
        .replace(/\s+--host\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function withHostAndPort(script: string) {
    const cleaned = stripDevHostFlags(script || 'next dev');

    if (/^vite(?:\s|$)/.test(cleaned)) {
        return `${cleaned} --host 0.0.0.0 --port ${PREVIEW_PORT}`;
    }

    return `${cleaned} --hostname 0.0.0.0 --port ${PREVIEW_PORT}`;
}

function normalizePackageJson(content: string) {
    try {
        const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
        pkg.scripts ??= {};
        pkg.scripts.dev = withHostAndPort(pkg.scripts.dev ?? 'next dev');

        return `${JSON.stringify(pkg, null, 2)}\n`;
    } catch {
        return content;
    }
}

async function clearPreviewDir() {
    await mkdir(PREVIEW_DIR, { recursive: true });
    const entries = await readdir(PREVIEW_DIR);

    await Promise.all(
        entries.map((entry) => rm(path.join(PREVIEW_DIR, entry), { recursive: true, force: true })),
    );
}

export async function POST(req: Request) {
    if (!env.NEXT_PUBLIC_LOCAL_PREVIEW_ONLY) {
        return Response.json({ error: 'Local preview mode is disabled' }, { status: 400 });
    }

    const body = importSchema.parse(await req.json());
    await clearPreviewDir();

    for (const file of body.files) {
        const target = safePath(file.path);
        await mkdir(path.dirname(target), { recursive: true });

        const content =
            file.type === 'binary'
                ? Buffer.from(file.content, 'base64')
                : file.path.endsWith('package.json')
                  ? normalizePackageJson(file.content)
                  : file.content;

        await writeFile(target, content);
    }

    await writeFile(path.join(PREVIEW_DIR, RESTART_MARKER), String(Date.now()));

    return Response.json({
        ok: true,
        fileCount: body.files.length,
        previewUrl: env.NEXT_PUBLIC_LOCAL_PREVIEW_URL,
    });
}
