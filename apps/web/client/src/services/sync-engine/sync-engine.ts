/**
 * Handles syncing files between a code provider and a local file system.
 *
 * On initial start, it pulls all files from the provider and stores them in the local file system.
 * After this, it watches for changes either in the local file system or the provider and syncs the changes back and forth.
 */
import { type Provider, type ProviderFileWatcher } from '@onlook/code-provider';

import { normalizePath } from '@/components/store/editor/sandbox/helpers';
import type { CodeFileSystem } from '@onlook/file-system';

export interface SyncConfig {
    include?: string[];
    exclude?: string[];
}

const DEFAULT_EXCLUDES = ['node_modules', '.git', '.next', 'dist', 'build', '.turbo'];
const PROVIDER_READ_CONCURRENCY = 16;
const DEFAULT_INCLUDED_TOP_LEVEL_PATHS = new Set([
    'app',
    'components',
    'lib',
    'pages',
    'providers',
    'src',
]);
const DEFAULT_INCLUDED_ROOT_FILES = new Set([
    'components.json',
    'next.config.js',
    'next.config.mjs',
    'next.config.ts',
    'package.json',
    'postcss.config.js',
    'postcss.config.mjs',
    'postcss.config.ts',
    'tailwind.config.js',
    'tailwind.config.mjs',
    'tailwind.config.ts',
    'tsconfig.json',
]);
const DEFAULT_INCLUDED_FILE_EXTENSIONS = new Set(['.css', '.js', '.json', '.jsx', '.mjs', '.tsx']);
const DEFAULT_EXCLUDED_FILE_EXTENSIONS = new Set([
    '.bmp',
    '.gif',
    '.ico',
    '.jpeg',
    '.jpg',
    '.png',
    '.sqlite',
    '.sqlite-shm',
    '.sqlite-wal',
    '.tsbuildinfo',
    '.webp',
]);
const DEFAULT_EXCLUDED_FILE_NAMES = new Set(['.ds_store', 'thumbs.db']);

export async function hashContent(content: string | Uint8Array): Promise<string> {
    const encoder = new TextEncoder();
    const data = typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);

    if (globalThis.crypto?.subtle) {
        const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    let hash = 0x811c9dc5;
    for (const byte of data) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = [];
    let index = 0;

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (index < items.length) {
            const currentIndex = index++;
            const item = items[currentIndex];
            if (item !== undefined) {
                results[currentIndex] = await mapper(item);
            }
        }
    });

    await Promise.all(workers);
    return results;
}

interface SyncInstance {
    sync: CodeProviderSync;
    refCount: number;
}

export class CodeProviderSync {
    private static instances = new Map<string, SyncInstance>();

    private watcher: ProviderFileWatcher | null = null;
    private localWatcher: (() => void) | null = null;
    private isRunning = false;
    private isPaused = false;
    private readonly excludes: string[];
    private readonly excludePatterns: string[];
    private fileHashes = new Map<string, string>();
    private filesPendingProviderPush = new Set<string>();
    private instanceKey: string | null = null;

    private constructor(
        private provider: Provider,
        private fs: CodeFileSystem,
        private config: SyncConfig = { include: [], exclude: [] },
    ) {
        // Compute excludes once
        this.excludes = [...DEFAULT_EXCLUDES, ...(this.config.exclude ?? [])];
        this.excludePatterns = this.excludes.map((dir) => `${dir}/**`);
    }

    /**
     * Get or create a sync instance for the given provider and filesystem.
     * Uses reference counting to ensure the same provider+fs combination shares a single sync instance.
     *
     * Note: Config is only applied on first creation. Subsequent calls with the same provider+fs
     * will reuse the existing instance with its original config. In practice, configs are static
     * (EXCLUDED_SYNC_PATHS) so this shouldn't cause issues, but a warning is logged if detected.
     */
    static getInstance(
        provider: Provider,
        fs: CodeFileSystem,
        sandboxId: string,
        config: SyncConfig = { include: [], exclude: [] },
    ): CodeProviderSync {
        const key = CodeProviderSync.generateKey(sandboxId, fs);

        const existing = CodeProviderSync.instances.get(key);
        if (existing) {
            // Warn if configs differ to help debug unexpected behavior
            const sameConfig =
                JSON.stringify(existing.sync.config ?? {}) === JSON.stringify(config ?? {});
            if (!sameConfig) {
                console.warn(
                    `[Sync] getInstance(${key}) called with different config; reusing existing instance config`,
                );
            }
            existing.refCount++;
            console.log(`[Sync] Reusing existing sync instance for ${key} (refCount: ${existing.refCount})`);
            return existing.sync;
        }

        const sync = new CodeProviderSync(provider, fs, config);
        sync.instanceKey = key;
        CodeProviderSync.instances.set(key, { sync, refCount: 1 });
        console.log(`[Sync] Created new sync instance for ${key} (refCount: 1)`);
        return sync;
    }

    /**
     * Generate a unique key for a provider+filesystem combination.
     */
    private static generateKey(sandboxId: string, fs: CodeFileSystem): string {
        return `${sandboxId}:${fs.rootPath}`;
    }

    /**
     * Release a reference to this sync instance.
     * When the last reference is released, the sync will be stopped and removed from the registry.
     */
    release(): void {
        if (!this.instanceKey) {
            console.warn('[Sync] Attempted to release sync instance without a key');
            return;
        }

        const instance = CodeProviderSync.instances.get(this.instanceKey);
        if (!instance) {
            console.warn(`[Sync] Instance ${this.instanceKey} not found in registry`);
            return;
        }

        instance.refCount--;
        console.log(`[Sync] Released reference to ${this.instanceKey} (refCount: ${instance.refCount})`);

        if (instance.refCount <= 0) {
            console.log(`[Sync] Stopping and removing sync instance ${this.instanceKey}`);
            this.stop();
            CodeProviderSync.instances.delete(this.instanceKey);
            this.instanceKey = null;
        }
    }

    /**
     * Pause syncing temporarily. Useful before operations that cause many file changes (e.g., git restore).
     * While paused, file change events are ignored.
     */
    pause(): void {
        this.isPaused = true;
    }

    /**
     * Resume syncing after being paused. Pulls fresh state from sandbox to ensure consistency.
     */
    async unpause(): Promise<void> {
        // Keep paused while reconciling to avoid echoing local writes back to the provider
        if (this.isRunning) {
            try {
                await this.pullFromSandbox();
            } finally {
                this.isPaused = false;
            }
        } else {
            this.isPaused = false;
        }
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            return;
        }

        this.isRunning = true;

        try {
            await this.pullFromSandbox();
            // Push any locally modified files (with OIDs) back to sandbox. This is required for the first time sync.
            void this.pushModifiedFilesToSandbox();
        } catch (error) {
            this.isRunning = false;
            throw error;
        }
    }

    async startWatching(): Promise<void> {
        if (!this.isRunning || this.watcher || this.localWatcher) {
            return;
        }

        await this.setupWatching();
    }

    stop(): void {
        this.isRunning = false;

        if (this.watcher) {
            void this.watcher.stop();
            this.watcher = null;
        }

        if (this.localWatcher) {
            this.localWatcher();
            this.localWatcher = null;
        }

        // Clear file hashes
        this.fileHashes.clear();
    }

    private async pullFromSandbox(): Promise<void> {
        const sandboxEntries = await this.getAllSandboxFiles('');
        console.log(`[Sync] Pulled ${sandboxEntries.length} entries from sandbox`);
        const sandboxEntriesSet = new Set(
            sandboxEntries.map((e) => (e.path.startsWith('/') ? e.path : `/${e.path}`)),
        );

        const localEntries = await this.fs.listAll();

        // Find entries to delete (exist locally but not in sandbox)
        const entriesToDelete = localEntries.filter((entry) => {
            if (!this.shouldSync(entry.path)) return false;

            const sandboxPath = entry.path.startsWith('/') ? entry.path.substring(1) : entry.path;
            return !sandboxEntriesSet.has(entry.path) && !sandboxEntriesSet.has(sandboxPath);
        });

        for (const entry of entriesToDelete) {
            try {
                if (entry.type === 'file') {
                    await this.fs.deleteFile(entry.path);
                    console.log(`[Sync] Deleted file: ${entry.path}`);
                } else {
                    await this.fs.deleteDirectory(entry.path);
                    console.log(`[Sync] Deleted directory: ${entry.path}`);
                }
            } catch (error) {
                console.debug(
                    `[Sync] Failed to delete ${entry.path}:`,
                    error instanceof Error ? error.message : 'Unknown error',
                );
            }
        }

        // Process sandbox entries
        const directoriesToCreate = sandboxEntries
            .filter((entry) => entry.type === 'directory')
            .map((entry) => entry.path);
        const fileEntries = sandboxEntries.filter((entry) => entry.type === 'file');
        const filesToWrite = (
            await mapWithConcurrency(fileEntries, PROVIDER_READ_CONCURRENCY, async (entry) => {
                try {
                    const result = await this.provider.readFile({ args: { path: entry.path } });
                    const { file } = result;

                    if ((file.type === 'text' || file.type === 'binary') && file.content) {
                        return { path: entry.path, content: file.content };
                    }
                } catch (error) {
                    console.debug(`[Sync] Skipping ${entry.path}:`, error);
                }
                return null;
            })
        ).filter((file): file is { path: string; content: string | Uint8Array } => file !== null);

        // Create directories first
        for (const dirPath of directoriesToCreate) {
            try {
                await this.fs.createDirectory(dirPath);
            } catch (error) {
                console.debug(`[Sync] Error creating directory ${dirPath}:`, error);
            }
        }

        // Write files sequentially to avoid race conditions
        for (const { path, content } of filesToWrite) {
            try {
                const changed = await this.fs.writeFileFromProvider(path, content);
                if (changed) {
                    this.filesPendingProviderPush.add(path);
                }
            } catch (error) {
                console.error(`[Sync] Failed to write ${path}:`, error);
            }
        }

        console.log(`[Sync] Wrote ${filesToWrite.length} files to local filesystem`);

        // Store hashes of files so we can skip syncing if the content hasn't changed later.
        for (const { path, content } of filesToWrite) {
            const hash = await hashContent(content);
            this.fileHashes.set(path, hash);
        }
    }

    private async getAllSandboxFiles(
        dir: string,
    ): Promise<Array<{ path: string; type: 'file' | 'directory' }>> {
        const files: Array<{ path: string; type: 'file' | 'directory' }> = [];

        try {
            const result = await this.provider.listFiles({ args: { path: dir || '.' } });
            const entries = result.files;

            for (const entry of entries) {
                const fullPath = dir ? `${dir}/${entry.name}` : entry.name;

                if (entry.type === 'directory') {
                    // Check if directory should be excluded
                    if (!this.excludes.includes(entry.name)) {
                        if (this.shouldSync(fullPath)) {
                            files.push({ path: fullPath, type: 'directory' });
                        }
                        const subFiles = await this.getAllSandboxFiles(fullPath);
                        files.push(...subFiles);
                    }
                } else {
                    // Only add files that should be synced
                    if (this.shouldSync(fullPath)) {
                        files.push({ path: fullPath, type: entry.type });
                    }
                }
            }
        } catch (error) {
            console.debug(
                `[Sync] Error reading directory ${dir}:`,
                error instanceof Error ? error.message : 'Unknown error',
            );
        }

        return files;
    }

    private async pushModifiedFilesToSandbox(): Promise<void> {
        console.log('[Sync] Pushing locally modified files back to sandbox...');

        try {
            const changedFiles = Array.from(this.filesPendingProviderPush);
            if (changedFiles.length === 0) {
                return;
            }

            // TODO: Use available batch write API
            await Promise.all(
                changedFiles.map(async (filePath) => {
                    try {
                        const content = await this.fs.readFile(filePath);
                        if (typeof content === 'string') {
                            const existingHash = this.fileHashes.get(filePath);
                            const currentHash = await hashContent(content);
                            if (existingHash === currentHash) {
                                return;
                            }

                            // Push to sandbox
                            await this.provider.writeFile({
                                args: {
                                    path: filePath.startsWith('/') ? filePath.substring(1) : filePath,
                                    content,
                                    overwrite: true
                                }
                            });
                            this.fileHashes.set(filePath, currentHash);
                            console.log(`[Sync] Pushed ${filePath} to sandbox`);
                        }
                        this.filesPendingProviderPush.delete(filePath);
                    } catch (error) {
                        console.warn(`[Sync] Failed to push ${filePath} to sandbox:`, error);
                    }
                })
            );
        } catch (error) {
            console.error('[Sync] Error pushing files to sandbox:', error);
        }
    }

    private shouldSync(path: string): boolean {
        const lowerPath = path.toLowerCase();
        const normalizedPath = lowerPath.startsWith('./')
            ? lowerPath.slice(2)
            : lowerPath.startsWith('/')
                ? lowerPath.slice(1)
                : lowerPath;
        const topLevelPath = normalizedPath.split('/')[0];
        if (
            normalizedPath.includes('/') &&
            topLevelPath &&
            !DEFAULT_INCLUDED_TOP_LEVEL_PATHS.has(topLevelPath)
        ) {
            return false;
        }

        if (!normalizedPath.includes('/') && !DEFAULT_INCLUDED_ROOT_FILES.has(normalizedPath)) {
            return false;
        }

        const fileName = lowerPath.split('/').pop() ?? lowerPath;
        if (DEFAULT_EXCLUDED_FILE_NAMES.has(fileName)) {
            return false;
        }

        const dotIndex = fileName.lastIndexOf('.');
        if (dotIndex > 0) {
            const extension = fileName.slice(dotIndex);
            if (!DEFAULT_INCLUDED_FILE_EXTENSIONS.has(extension)) {
                return false;
            }
        }

        for (const extension of DEFAULT_EXCLUDED_FILE_EXTENSIONS) {
            if (lowerPath.endsWith(extension)) {
                return false;
            }
        }

        // Check if path matches any exclude pattern
        const isExcluded = this.excludes.some((exc) => {
            // Check if path is within excluded directory or is the excluded item itself
            return path === exc || path.startsWith(`${exc}/`) || path.split('/').includes(exc);
        });

        if (isExcluded) {
            return false;
        }

        // Check includes if specified
        if (this.config.include && this.config.include.length > 0) {
            const included = this.config.include.some((inc) => {
                const normalizedInc = inc.startsWith('/') ? inc.substring(1) : inc;
                return path.startsWith(normalizedInc) || path === normalizedInc;
            });
            return included;
        }

        return true;
    }

    private async setupWatching(): Promise<void> {
        try {
            // Watch the current directory (relative to workspace)
            const watchResult = await this.provider.watchFiles({
                args: {
                    path: './',
                    recursive: true,
                    excludes: this.excludePatterns,
                },
                onFileChange: async (event) => {
                    // Skip processing if paused
                    if (this.isPaused) {
                        return;
                    }

                    // Process based on event type
                    if (event.type === 'change' || event.type === 'add') {
                        // Check if this is a rename (change event with 2 paths)
                        if (
                            event.type === 'change' &&
                            event.paths.length === 2 &&
                            event.paths[0] &&
                            event.paths[1]
                        ) {
                            // This is likely a rename operation
                            const oldPath = normalizePath(event.paths[0]);
                            const newPath = normalizePath(event.paths[1]);


                            if (this.shouldSync(oldPath) && this.shouldSync(newPath)) {
                                try {
                                    // Check if the old file exists locally
                                    if (await this.fs.exists(oldPath)) {
                                        // Rename the file locally
                                        await this.fs.moveFile(oldPath, newPath);

                                        // Update hash tracking
                                        const oldHash = this.fileHashes.get(oldPath);
                                        if (oldHash) {
                                            this.fileHashes.delete(oldPath);
                                            this.fileHashes.set(newPath, oldHash);
                                        }
                                    } else {
                                        // Old file doesn't exist, just create the new one

                                        try {
                                            const result = await this.provider.readFile({
                                                args: { path: newPath },
                                            });
                                            const { file } = result;

                                            if (
                                                (file.type === 'text' || file.type === 'binary') &&
                                                file.content
                                            ) {
                                                const changed = await this.fs.writeFileFromProvider(newPath, file.content);
                                                if (changed) {
                                                    this.filesPendingProviderPush.add(newPath);
                                                }
                                                const hash = await hashContent(file.content);
                                                this.fileHashes.set(newPath, hash);
                                            }
                                        } catch (error) {
                                            console.error(
                                                `[Sync] Error creating ${newPath}:`,
                                                error,
                                            );
                                        }
                                    }
                                } catch (error) {
                                    console.error(`[Sync] Error handling rename:`, error);
                                }
                            }
                        } else {
                            // Normal processing for non-rename events
                            for (const path of event.paths) {

                                // Normalize the path to remove any duplicate prefixes
                                const normalizedPath = normalizePath(path);

                                if (!this.shouldSync(normalizedPath)) {
                                    continue;
                                }

                                try {
                                    // First check if it's a directory or file
                                    const stat = await this.provider.statFile({
                                        args: { path: normalizedPath },
                                    });

                                    if (stat.type === 'directory') {
                                        // It's a directory, create it locally
                                        const localPath = normalizedPath;

                                        try {
                                            await this.fs.createDirectory(localPath);

                                            // After creating the directory, recursively sync all its contents
                                            // This is needed because sandbox watcher might only report parent directory creation

                                            // Recursive function to sync directory contents
                                            const syncDirectoryContents = async (sandboxPath: string, localDirPath: string) => {
                                                try {
                                                    const dirContents = await this.provider.listFiles({
                                                        args: { path: sandboxPath },
                                                    });

                                                    if (dirContents.files && dirContents.files.length > 0) {

                                                        for (const item of dirContents.files) {
                                                            const itemSandboxPath = `${sandboxPath}/${item.name}`;
                                                            const itemLocalPath = `${localDirPath}/${item.name}`;

                                                            if (item.type === 'directory') {
                                                                // Create subdirectory
                                                                await this.fs.createDirectory(itemLocalPath);

                                                                // Recursively sync its contents
                                                                await syncDirectoryContents(itemSandboxPath, itemLocalPath);
                                                            } else if (item.type === 'file') {
                                                                // Sync all files including .gitkeep
                                                                try {
                                                                    const fileResult = await this.provider.readFile({
                                                                        args: { path: itemSandboxPath },
                                                                    });
                                                                    if (fileResult.file.content !== undefined) {
                                                                        // Write file even if content is empty (like .gitkeep)
                                                                        const changed = await this.fs.writeFileFromProvider(itemLocalPath, fileResult.file.content || '');
                                                                        if (changed) {
                                                                            this.filesPendingProviderPush.add(itemLocalPath);
                                                                        }
                                                                        // Update hash tracking
                                                                        const hash = await hashContent(fileResult.file.content || '');
                                                                        this.fileHashes.set(itemLocalPath, hash);
                                                                    } else {
                                                                        console.log(`[Sync] File ${itemSandboxPath} has undefined content, skipping`);
                                                                    }
                                                                } catch (fileError) {
                                                                    console.error(`[Sync] Error syncing file ${itemSandboxPath}:`, fileError);
                                                                }
                                                            }
                                                        }
                                                    }
                                                } catch (listError) {
                                                    console.error(`[Sync] Error listing contents of ${sandboxPath}:`, listError);
                                                }
                                            };

                                            // Start recursive sync
                                            await syncDirectoryContents(normalizedPath, localPath);
                                        } catch (dirError) {
                                            console.error(`[Sync] Error creating directory ${localPath}:`, dirError);
                                            // Directory creation might fail if parent doesn't exist
                                            // The createDirectory method should handle this with recursive: true
                                        }
                                    } else {
                                        // It's a file, read and sync it
                                        const result = await this.provider.readFile({
                                            args: { path: normalizedPath },
                                        });
                                        const { file } = result;

                                        if (
                                            (file.type === 'text' || file.type === 'binary') &&
                                            file.content
                                        ) {
                                            const localPath = normalizedPath;

                                            // Check if content has changed
                                            const newHash = await hashContent(file.content);
                                            const existingHash = this.fileHashes.get(localPath);

                                            if (newHash !== existingHash) {
                                                const changed = await this.fs.writeFileFromProvider(localPath, file.content);
                                                if (changed) {
                                                    this.filesPendingProviderPush.add(localPath);
                                                }
                                                this.fileHashes.set(localPath, newHash);
                                            } else {
                                                console.debug(
                                                    `[Sync] Skipping ${localPath} - content unchanged`,
                                                );
                                            }
                                        }
                                    }
                                } catch (error) {
                                    console.error(`[Sync] Error processing ${normalizedPath}:`, error);
                                }
                            }
                        }
                    } else if (event.type === 'remove') {
                        for (const path of event.paths) {
                            // Normalize the path to remove any duplicate prefixes
                            const normalizedPath = normalizePath(path);

                            if (!this.shouldSync(normalizedPath)) {
                                console.debug(
                                    `[Sync] Skipping sandbox delete for excluded path: ${normalizedPath}`,
                                );
                                continue;
                            }

                            try {
                                const localPath = normalizedPath;

                                // Check if path exists before trying to delete
                                if (await this.fs.exists(localPath)) {
                                    // Check if it's a directory or file
                                    const fileInfo = await this.fs.getInfo(localPath);

                                    if (fileInfo.isDirectory) {
                                        await this.fs.deleteDirectory(localPath);
                                    } else {
                                        await this.fs.deleteFile(localPath);
                                    }
                                }

                                // Remove hash regardless
                                this.fileHashes.delete(localPath);
                            } catch (error) {
                                console.debug(
                                    `[Sync] Error deleting ${normalizedPath} locally:`,
                                    error instanceof Error ? error.message : 'Unknown error',
                                );
                            }
                        }
                    }
                },
            });

            this.watcher = watchResult.watcher;

            // Setup local file system watching for bidirectional sync
            await this.setupLocalWatching();
        } catch (error) {
            console.error(
                '[Sync] Failed to setup file watching:',
                error instanceof Error ? error.message : 'Unknown error',
            );
            throw error;
        }
    }

    private async setupLocalWatching(): Promise<void> {
        // Watch the root directory for local changes
        this.localWatcher = this.fs.watchDirectory('/', async (event) => {
            // Skip processing if paused
            if (this.isPaused) {
                return;
            }

            const { path, type } = event;

            // Check if file should be synced
            // Need to remove leading / for sandbox path
            const sandboxPath = path.startsWith('/') ? path.substring(1) : path;
            if (!this.shouldSync(sandboxPath)) {
                console.debug(`[Sync] Skipping local ${type} for excluded path: ${path}`);
                return;
            }

            try {
                switch (type) {
                    case 'create':
                    case 'update': {
                        // Check if it's a directory
                        const fileInfo = await this.fs.getInfo(path);

                        if (fileInfo.isDirectory) {
                            // Create directory in provider
                            await this.provider.createDirectory({
                                args: {
                                    path: sandboxPath,
                                },
                            });
                        } else {
                            // Read from local and write to provider
                            const content = await this.fs.readFile(path);
                            const currentHash = await hashContent(content);

                            // Check if this change was from our own sync
                            if (this.fileHashes.get(path) === currentHash) {
                                return;
                            }

                            // Update hash and sync to provider
                            this.fileHashes.set(path, currentHash);
                            await this.provider.writeFile({
                                args: {
                                    path: sandboxPath,
                                    content,
                                    overwrite: true,
                                },
                            });
                        }
                        break;
                    }
                    case 'delete': {
                        // Always attempt to sync local deletions to sandbox
                        // The user initiated this deletion locally, so it should be reflected in the sandbox

                        try {
                            await this.provider.deleteFiles({
                                args: {
                                    path: sandboxPath,
                                    recursive: true,
                                },
                            });
                        } catch (error) {
                            console.debug(
                                `[Sync] Failed to delete ${sandboxPath} from sandbox:`,
                                error instanceof Error ? error.message : 'Unknown error',
                            );
                        }

                        // Remove hash for deleted file (if it exists)
                        if (this.fileHashes.has(path)) {
                            this.fileHashes.delete(path);
                            console.debug(`[Sync] Removed hash entry for deleted file: ${path}`);
                        }
                        break;
                    }
                    case 'rename': {
                        // Handle rename if oldPath is provided
                        if (event.oldPath) {
                            const oldSandboxPath = event.oldPath.startsWith('/')
                                ? event.oldPath.substring(1)
                                : event.oldPath;

                            try {
                                await this.provider.renameFile({
                                    args: {
                                        oldPath: oldSandboxPath,
                                        newPath: sandboxPath,
                                    },
                                });

                                // Update hash tracking for renamed files
                                const oldHash = this.fileHashes.get(event.oldPath);
                                if (oldHash) {
                                    this.fileHashes.delete(event.oldPath);
                                    this.fileHashes.set(path, oldHash);
                                }
                            } catch (error) {
                                console.error(`[Sync] Failed to rename in sandbox:`, error);
                                throw error; // Re-throw to be caught by outer try-catch
                            }
                        } else {
                            console.warn(`[Sync] Rename event received without oldPath`);
                        }
                        break;
                    }
                }
            } catch (error) {
                console.error(
                    `[Sync] Error pushing local ${type} for ${path} to sandbox:`,
                    error instanceof Error ? error.message : 'Unknown error',
                );
            }
        });
    }
}
