import debounce from 'lodash.debounce';

import { ONLOOK_CACHE_DIRECTORY, ONLOOK_PRELOAD_SCRIPT_FILE } from '@onlook/constants';
import { RouterType } from '@onlook/models';
import {
    addOidsToAst,
    createTemplateNodeMap,
    formatContent,
    getAstFromContent,
    getContentFromAst,
    getContentFromTemplateNode,
    injectPreloadScript,
} from '@onlook/parser';
import { isAppEntryLayoutFile, pathsEqual } from '@onlook/utility';

import type { JsxElementMetadata } from './index-cache';
import { FileSystem } from './fs';
import {
    clearIndexCache,
    getIndexFromCache,
    getOrLoadIndex,
    saveIndexToCache,
} from './index-cache';

export type { JsxElementMetadata } from './index-cache';

export interface CodeEditorOptions {
    routerType?: RouterType;
}

export class CodeFileSystem extends FileSystem {
    private projectId: string;
    private branchId: string;
    private options: Required<CodeEditorOptions>;
    private indexPath = `${ONLOOK_CACHE_DIRECTORY}/index.json`;
    private indexRebuildPromise: Promise<void> | null = null;

    constructor(projectId: string, branchId: string, options: CodeEditorOptions = {}) {
        super(`/${projectId}/${branchId}`);
        this.projectId = projectId;
        this.branchId = branchId;
        this.options = {
            routerType: options.routerType ?? RouterType.APP,
        };
    }

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
        if (this.isJsxFile(path) && typeof content === 'string') {
            const processedContent = await this.processJsxFile(path, content);
            await super.writeFile(path, processedContent);
        } else {
            await super.writeFile(path, content);
        }
    }

    async writeFileFromProvider(path: string, content: string | Uint8Array): Promise<boolean> {
        if (this.shouldInjectOids(path, content)) {
            const processedContent = await this.injectOids(path, content);
            await super.writeFile(path, processedContent);
            return processedContent !== content;
        } else {
            await super.writeFile(path, content);
            return false;
        }
    }

    async writeFiles(files: Array<{ path: string; content: string | Uint8Array }>): Promise<void> {
        // Write files sequentially to avoid race conditions to metadata file
        for (const { path, content } of files) {
            await this.writeFile(path, content);
        }
    }

    private async processJsxFile(path: string, content: string): Promise<string> {
        const processedContent = await this.injectOids(path, content);

        const formattedContent = await formatContent(path, processedContent);
        await this.updateMetadataForFile(path, formattedContent);

        return formattedContent;
    }

    private shouldInjectOids(path: string, content: string | Uint8Array): content is string {
        if (!this.isJsxFile(path) || typeof content !== 'string') {
            return false;
        }

        if (/\.(jsx|tsx)$/i.test(path)) {
            return true;
        }

        return content.includes('data-oid') || new RegExp('<[A-Za-z][A-Za-z0-9.:-]*(\\\\s|>|/)').test(content);
    }

    private async injectOids(path: string, content: string): Promise<string> {
        const ast = getAstFromContent(content);
        if (!ast) {
            console.warn(`Failed to parse ${path}, skipping OID injection`);
            return content;
        }

        if (isAppEntryLayoutFile(path)) {
            injectPreloadScript(ast);
        }

        const existingOids = await this.getFileOids(path);
        const { ast: processedAst } = addOidsToAst(ast, existingOids);

        return await getContentFromAst(processedAst, content);
    }

    private async getFileOids(path: string): Promise<Set<string>> {
        const index = await this.loadIndex();

        const oids = new Set<string>();
        for (const [oid, metadata] of Object.entries(index)) {
            if (pathsEqual(metadata.path, path)) {
                oids.add(oid);
            }
        }
        return oids;
    }

    private async updateMetadataForFile(path: string, content: string): Promise<void> {
        const index = await this.loadIndex();

        for (const [oid, metadata] of Object.entries(index)) {
            if (pathsEqual(metadata.path, path)) {
                delete index[oid];
            }
        }

        const ast = getAstFromContent(content);
        if (!ast) return;

        const templateNodeMap = createTemplateNodeMap({
            ast,
            filename: path,
            branchId: this.branchId,
        });

        for (const [oid, node] of templateNodeMap.entries()) {
            const code = await getContentFromTemplateNode(node, content);
            const metadata: JsxElementMetadata = {
                ...node,
                oid,
                code: code || '',
            };
            index[oid] = metadata;
        }

        await this.saveIndex(index);
    }

    async getJsxElementMetadata(oid: string): Promise<JsxElementMetadata | undefined> {
        const index = await this.loadIndex();
        let metadata = index[oid];
        const indexSize = Object.keys(index).length;

        if (!metadata && indexSize === 0) {
            await this.rebuildIndexOnce();
            const rebuiltIndex = await this.loadIndex();
            metadata = rebuiltIndex[oid];
        }

        if (!metadata) {
            const latestIndex = getIndexFromCache(this.getCacheKey()) ?? index;
            console.warn(
                `[CodeEditorApi] No metadata found for OID: ${oid}. Total index size: ${Object.keys(latestIndex).length}`,
            );
        }
        return metadata;
    }

    private async rebuildIndexOnce(): Promise<void> {
        this.indexRebuildPromise ??= this.rebuildIndex().finally(() => {
            this.indexRebuildPromise = null;
        });
        await this.indexRebuildPromise;
    }

    async rebuildIndex(): Promise<void> {
        const startTime = Date.now();
        const index: Record<string, JsxElementMetadata> = {};

        const entries = await this.listAll();
        const jsxFiles = entries.filter(
            (entry) => entry.type === 'file' && this.isJsxFile(entry.path),
        );

        const BATCH_SIZE = 10;
        let processedCount = 0;

        for (let i = 0; i < jsxFiles.length; i += BATCH_SIZE) {
            const batch = jsxFiles.slice(i, i + BATCH_SIZE);
            await Promise.all(
                batch.map(async (entry) => {
                    try {
                        const content = await this.readFile(entry.path);
                        if (typeof content === 'string') {
                            const ast = getAstFromContent(content);
                            if (!ast) return;

                            const templateNodeMap = createTemplateNodeMap({
                                ast,
                                filename: entry.path,
                                branchId: this.branchId,
                            });

                            for (const [oid, node] of templateNodeMap.entries()) {
                                const code = await getContentFromTemplateNode(node, content);
                                index[oid] = {
                                    ...node,
                                    oid,
                                    code: code || '',
                                };
                            }

                            processedCount++;
                        }
                    } catch (error) {
                        console.error(`Error indexing ${entry.path}:`, error);
                    }
                }),
            );
        }

        await this.saveIndex(index);

        const duration = Date.now() - startTime;
        console.log(
            `[CodeEditorApi] Index built: ${Object.keys(index).length} elements from ${processedCount} files in ${duration}ms`,
        );
    }

    async deleteFile(path: string): Promise<void> {
        await super.deleteFile(path);

        if (this.isJsxFile(path)) {
            const index = await this.loadIndex();
            let hasChanges = false;

            for (const [oid, metadata] of Object.entries(index)) {
                if (pathsEqual(metadata.path, path)) {
                    delete index[oid];
                    hasChanges = true;
                }
            }

            if (hasChanges) {
                await this.saveIndex(index);
            }
        }
    }

    async moveFile(oldPath: string, newPath: string): Promise<void> {
        await super.moveFile(oldPath, newPath);

        if (this.isJsxFile(oldPath) && this.isJsxFile(newPath)) {
            const index = await this.loadIndex();
            let hasChanges = false;

            for (const metadata of Object.values(index)) {
                if (pathsEqual(metadata.path, oldPath)) {
                    metadata.path = newPath;
                    hasChanges = true;
                }
            }

            if (hasChanges) {
                await this.saveIndex(index);
            }
        }
    }

    private async loadIndex(): Promise<Record<string, JsxElementMetadata>> {
        return getOrLoadIndex(this.getCacheKey(), this.indexPath, (path) => this.readFile(path));
    }

    private async saveIndex(index: Record<string, JsxElementMetadata>): Promise<void> {
        saveIndexToCache(this.getCacheKey(), index);
        void this.debouncedSaveIndexToFile();
    }

    private async undobounceSaveIndexToFile(): Promise<void> {
        try {
            await this.createDirectory(ONLOOK_CACHE_DIRECTORY);
        } catch {
            console.warn(`[CodeEditorApi] Failed to create ${ONLOOK_CACHE_DIRECTORY} directory`);
        }
        const index = getIndexFromCache(this.getCacheKey());
        if (index) {
            await super.writeFile(this.indexPath, JSON.stringify(index));
        }
    }

    private debouncedSaveIndexToFile = debounce(this.undobounceSaveIndexToFile, 1000);

    private isJsxFile(path: string): boolean {
        // Exclude the onlook preload script from JSX processing
        if (path.endsWith(ONLOOK_PRELOAD_SCRIPT_FILE)) {
            return false;
        }
        return /\.(jsx?|tsx?)$/i.test(path);
    }

    async cleanup(): Promise<void> {
        const cacheKey = this.getCacheKey();
        if (getIndexFromCache(cacheKey)) {
            await this.undobounceSaveIndexToFile();
        }

        clearIndexCache(cacheKey);
    }

    private getCacheKey(): string {
        return `${this.projectId}/${this.branchId}`;
    }
}
