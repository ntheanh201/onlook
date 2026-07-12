import path from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import { env } from '@/env';

const PREVIEW_DIR =
    process.env.LOCAL_PREVIEW_DIR ?? path.resolve(process.cwd(), '../../..', 'local-preview');

// Coarse excludes so we never descend into heavy/irrelevant trees (chokidar's `ignored`
// prevents watching these at all, avoiding inotify exhaustion). The sync engine applies
// its own finer `excludes` filter on top of whatever we emit.
const EXCLUDED_SEGMENTS = new Set([
    'node_modules',
    '.next',
    '.next-prod',
    '.git',
    '.onlook',
    'dist',
    'build',
]);
const EXCLUDED_FILES = new Set(['.onlook-restart', '.DS_Store']);

function shouldIgnore(absPath: string): boolean {
    const rel = path.relative(PREVIEW_DIR, absPath);
    // The root dir itself (rel === '') must not be ignored, or nothing is watched.
    if (!rel || rel.startsWith('..')) {
        return false;
    }
    if (EXCLUDED_FILES.has(path.basename(rel))) {
        return true;
    }
    return rel.split(path.sep).some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

// Stream file-change events from the local-preview project directory as Server-Sent Events.
// The NodeFs provider's file watcher (client-side) subscribes to this so the editor's sync
// engine sees external disk changes — bringing NodeFs to parity with the sandbox providers.
export async function GET() {
    if (!env.NEXT_PUBLIC_LOCAL_PREVIEW_ONLY) {
        return Response.json({ error: 'Local preview mode is disabled' }, { status: 400 });
    }

    const encoder = new TextEncoder();
    let watcher: FSWatcher | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const send = (payload: unknown) => {
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
                } catch {
                    // Controller already closed (client disconnected).
                }
            };

            const emit = (type: 'add' | 'change' | 'remove', absPath: string) => {
                const rel = path.relative(PREVIEW_DIR, absPath).replaceAll('\\', '/');
                if (!rel) {
                    return;
                }
                send({ type, paths: [rel] });
            };

            watcher = chokidar.watch(PREVIEW_DIR, {
                ignoreInitial: true,
                ignored: (candidate: string) => shouldIgnore(candidate),
                persistent: true,
                // Debounce partial writes so we emit once the file has finished being written
                // (avoids reading a half-written file mid-save).
                awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
            });

            watcher.on('add', (p) => emit('add', p));
            watcher.on('change', (p) => emit('change', p));
            watcher.on('unlink', (p) => emit('remove', p));
            watcher.on('ready', () => send({ type: 'ready' }));
            watcher.on('error', (error) =>
                send({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
            );

            // Comment ping keeps the SSE connection alive through idle-timeout proxies.
            keepAlive = setInterval(() => {
                try {
                    controller.enqueue(encoder.encode(': ping\n\n'));
                } catch {
                    // Controller already closed.
                }
            }, 25000);
        },
        cancel() {
            void watcher?.close();
            watcher = null;
            if (keepAlive) {
                clearInterval(keepAlive);
                keepAlive = null;
            }
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            // Disable proxy buffering so events flush immediately (nginx et al.).
            'X-Accel-Buffering': 'no',
        },
    });
}
