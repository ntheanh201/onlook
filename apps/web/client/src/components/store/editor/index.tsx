'use client';

import type { Branch, Project } from '@onlook/models';
import { usePostHog } from 'posthog-js/react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { EditorEngine } from './engine';

const EditorEngineContext = createContext<EditorEngine | null>(null);

export const useEditorEngine = () => {
    const ctx = useContext(EditorEngineContext);
    if (!ctx) throw new Error('useEditorEngine must be inside EditorEngineProvider');
    return ctx;
};

export const EditorEngineProvider = ({
    children,
    project,
    branches
}: {
    children: React.ReactNode,
    project: Project,
    branches: Branch[],
}) => {
    const posthog = usePostHog();
    const engineRef = useRef<EditorEngine | null>(null);
    const previewUpdatedAt = project.metadata?.previewImg?.updatedAt ?? null;

    const [editorEngine, setEditorEngine] = useState<EditorEngine | null>(null);

    useEffect(() => {
        let cancelled = false;
        const engine = new EditorEngine(project.id, posthog);

        const initializeEngine = async () => {
            await engine.initBranches(branches);
            await engine.init();
            engine.screenshot.lastScreenshotAt = previewUpdatedAt;

            if (cancelled) {
                engine.clear();
                return;
            }

            engineRef.current = engine;
            setEditorEngine(engine);
        };

        setEditorEngine(null);
        void initializeEngine();

        return () => {
            cancelled = true;
            if (engineRef.current === engine) {
                engineRef.current = null;
            }
            setTimeout(() => engine.clear(), 0);
        };
    }, [branches, posthog, project.id, previewUpdatedAt]);

    if (!editorEngine) {
        return (
            <div className="h-screen w-screen flex items-center justify-center">
                <div className="text-xl">Loading project...</div>
            </div>
        );
    }

    return (
        <EditorEngineContext.Provider value={editorEngine}>
            {children}
        </EditorEngineContext.Provider>
    );
};
