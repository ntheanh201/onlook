import {
    copyFile,
    cp,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { env } from '@/env';
import { z } from 'zod';

const PREVIEW_DIR =
    process.env.LOCAL_PREVIEW_DIR ?? path.resolve(process.cwd(), '../../..', 'local-preview');
const RESTART_MARKER = '.onlook-restart';

const requestSchema = z.object({
    action: z.enum([
        'copyFiles',
        'createDirectory',
        'deleteFiles',
        'listFiles',
        'readFile',
        'renameFile',
        'restart',
        'statFile',
        'writeFile',
    ]),
    args: z.record(z.string(), z.unknown()),
});

function safePath(inputPath: unknown) {
    if (typeof inputPath !== 'string') {
        throw new Error('Path is required');
    }

    const normalized = path.posix.normalize(inputPath.replaceAll('\\', '/')).replace(/^\/+/, '');
    if (!normalized || normalized === '.') {
        return PREVIEW_DIR;
    }
    if (normalized.startsWith('..') || normalized.includes('/../')) {
        throw new Error(`Invalid file path: ${inputPath}`);
    }

    return path.join(PREVIEW_DIR, normalized);
}

function isTextContent(buffer: Buffer) {
    const checkLength = Math.min(512, buffer.length);

    for (let index = 0; index < checkLength; index++) {
        const byte = buffer[index];
        if (byte === 0 || byte === undefined) {
            return false;
        }
        if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
            return false;
        }
    }

    return true;
}

async function touchRestartMarker() {
    await writeFile(path.join(PREVIEW_DIR, RESTART_MARKER), String(Date.now()));
}

function decodeContent(content: unknown) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return Buffer.from(content as number[]);
    }

    if (
        typeof content === 'object' &&
        content !== null &&
        'type' in content &&
        (content as { type?: string }).type === 'Buffer' &&
        Array.isArray((content as { data?: unknown }).data)
    ) {
        return Buffer.from((content as unknown as { data: number[] }).data);
    }

    return '';
}

function isNotFoundError(error: unknown) {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === 'ENOENT'
    );
}

export async function POST(req: Request) {
    if (!env.NEXT_PUBLIC_LOCAL_PREVIEW_ONLY) {
        return Response.json({ error: 'Local preview mode is disabled' }, { status: 400 });
    }

    const { action, args } = requestSchema.parse(await req.json());

    switch (action) {
        case 'listFiles': {
            const target = safePath(args.path);
            let entries;
            try {
                entries = await readdir(target, { withFileTypes: true });
            } catch (error) {
                if (isNotFoundError(error)) {
                    return Response.json({ files: [] });
                }
                throw error;
            }
            return Response.json({
                files: entries.map((entry) => ({
                    name: entry.name,
                    type: entry.isDirectory() ? 'directory' : 'file',
                    isSymlink: entry.isSymbolicLink(),
                })),
            });
        }

        case 'readFile': {
            const target = safePath(args.path);
            const buffer = await readFile(target);
            const isText = isTextContent(buffer);
            return Response.json({
                file: {
                    path: args.path,
                    type: isText ? 'text' : 'binary',
                    content: isText ? buffer.toString('utf8') : Array.from(buffer),
                },
            });
        }

        case 'writeFile': {
            const target = safePath(args.path);
            await mkdir(path.dirname(target), { recursive: true });
            const data = decodeContent(args.content);
            await writeFile(target, data);
            // Guard against silently truncated writes (e.g. an oversized JSON body clipped by a
            // reverse-proxy body limit): verify the file on disk matches the payload size and fail
            // loudly so the caller can retry rather than leaving a corrupted, unparseable file.
            const expectedBytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
            const writtenBytes = (await stat(target)).size;
            if (writtenBytes !== expectedBytes) {
                return Response.json(
                    {
                        error: `Write truncated for ${String(args.path)}: wrote ${writtenBytes} of ${expectedBytes} bytes`,
                    },
                    { status: 500 },
                );
            }
            return Response.json({ success: true });
        }

        case 'statFile': {
            const target = safePath(args.path);
            let stats;
            try {
                stats = await stat(target);
            } catch (error) {
                if (isNotFoundError(error)) {
                    return Response.json({ error: 'File not found' }, { status: 404 });
                }
                throw error;
            }
            return Response.json({
                type: stats.isDirectory() ? 'directory' : 'file',
                isSymlink: stats.isSymbolicLink(),
                size: stats.size,
                mtime: stats.mtimeMs,
                ctime: stats.ctimeMs,
                atime: stats.atimeMs,
            });
        }

        case 'deleteFiles': {
            await rm(safePath(args.path), {
                recursive: Boolean(args.recursive),
                force: true,
            });
            return Response.json({});
        }

        case 'renameFile': {
            const oldPath = safePath(args.oldPath);
            const newPath = safePath(args.newPath);
            await mkdir(path.dirname(newPath), { recursive: true });
            await rename(oldPath, newPath);
            return Response.json({});
        }

        case 'copyFiles': {
            const sourcePath = safePath(args.sourcePath);
            const targetPath = safePath(args.targetPath);
            await mkdir(path.dirname(targetPath), { recursive: true });

            if (args.recursive) {
                await cp(sourcePath, targetPath, {
                    recursive: true,
                    force: Boolean(args.overwrite),
                });
            } else {
                await copyFile(sourcePath, targetPath);
            }

            return Response.json({});
        }

        case 'createDirectory': {
            await mkdir(safePath(args.path), { recursive: true });
            return Response.json({});
        }

        case 'restart': {
            await touchRestartMarker();
            return Response.json({});
        }
    }
}
