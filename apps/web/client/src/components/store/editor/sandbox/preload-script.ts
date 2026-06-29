import type { Provider } from '@onlook/code-provider';
import { NEXT_JS_FILE_EXTENSIONS, ONLOOK_DEV_PRELOAD_SCRIPT_PATH, ONLOOK_DEV_PRELOAD_SCRIPT_SRC } from '@onlook/constants';
import { RouterType, type RouterConfig } from '@onlook/models';
import { getAstFromContent, getContentFromAst, injectPreloadScript } from '@onlook/parser';
import { isRootLayoutFile, normalizePath } from '@onlook/utility';
import path from 'path';

const isTextLayoutFile = (fileName: string): boolean => /^layout\.(tsx|ts|jsx|js)$/.test(fileName);

export async function copyPreloadScriptToPublic(provider: Provider, routerConfig: RouterConfig): Promise<void> {
    try {
        try {
            await provider.createDirectory({ args: { path: 'public' } });
        } catch {
            // Directory might already exist, ignore error
        }

        const scriptResponse = await fetch(ONLOOK_DEV_PRELOAD_SCRIPT_SRC);
        await provider.writeFile({
            args: {
                path: ONLOOK_DEV_PRELOAD_SCRIPT_PATH,
                content: await scriptResponse.text(),
                overwrite: true
            }
        });

        await injectPreloadScriptIntoLayout(provider, routerConfig);
    } catch (error) {
        console.error('[PreloadScript] Failed to copy preload script:', error);
    }
}

export async function injectPreloadScriptIntoLayout(provider: Provider, routerConfig: RouterConfig): Promise<void> {
    if (!routerConfig) {
        throw new Error('Could not detect router type for script injection. This is required for iframe communication.');
    }

    const layoutPath = await findLayoutPath(provider, routerConfig);
    if (!layoutPath) {
        throw new Error(`No layout files found in ${routerConfig.basePath}`);
    }

    const layoutResponse = await provider.readFile({ args: { path: layoutPath } });
    if (typeof layoutResponse.file.content !== 'string') {
        throw new Error(`Layout file ${layoutPath} is not a text file`);
    }

    const content = layoutResponse.file.content;
    const ast = getAstFromContent(content);
    if (!ast) {
        throw new Error(`Failed to parse layout file: ${layoutPath}`);
    }

    injectPreloadScript(ast);
    const modifiedContent = await getContentFromAst(ast, content);

    await provider.writeFile({
        args: {
            path: layoutPath,
            content: modifiedContent,
            overwrite: true
        }
    });
}

async function findLayoutPath(
    provider: Provider,
    routerConfig: RouterConfig,
): Promise<string | null> {
    const result = await provider.listFiles({ args: { path: routerConfig.basePath } });
    const directLayout = result.files.find(
        (file) =>
            file.type === 'file' &&
            isRootLayoutFile(`${routerConfig.basePath}/${file.name}`, routerConfig.type),
    );

    if (directLayout) {
        return `${routerConfig.basePath}/${directLayout.name}`;
    }

    if (routerConfig.type !== RouterType.APP) {
        return null;
    }

    for (const directory of result.files.filter((file) => file.type === 'directory')) {
        const nestedPath = `${routerConfig.basePath}/${directory.name}`;
        try {
            const nestedResult = await provider.listFiles({ args: { path: nestedPath } });
            const nestedLayout = nestedResult.files.find(
                (file) => file.type === 'file' && isTextLayoutFile(file.name),
            );
            if (nestedLayout) {
                return `${nestedPath}/${nestedLayout.name}`;
            }
        } catch {
            continue;
        }
    }

    return null;
}

export async function getLayoutPath(routerConfig: RouterConfig, fileExists: (path: string) => Promise<boolean>): Promise<string | null> {
    if (!routerConfig) {
        console.log('Could not detect Next.js router type');
        return null;
    }

    let layoutFileName: string;

    if (routerConfig.type === RouterType.PAGES) {
        layoutFileName = '_app';
    } else {
        layoutFileName = 'layout';
    }

    for (const extension of NEXT_JS_FILE_EXTENSIONS) {
        const layoutPath = path.join(routerConfig.basePath, `${layoutFileName}${extension}`);
        if (await fileExists(layoutPath)) {
            return normalizePath(layoutPath);
        }
    }

    console.log('Could not find layout file');
    return null;
}
