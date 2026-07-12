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
    const currentProjectId = useRef(project.id);
    const engineRef = useRef<EditorEngine | null>(null);

    const [editorEngine, setEditorEngine] = useState<EditorEngine | null>(null);

    // Initialize editor engine in the browser because branch setup uses IndexedDB.
    useEffect(() => {
        let cancelled = false;

        const initializeEngine = async () => {
            if (engineRef.current) {
                const engine = engineRef.current;
                setTimeout(() => engine.clear(), 0);
            }

            const newEngine = new EditorEngine(project.id, posthog);
            await newEngine.initBranches(branches);
            await newEngine.init();
            newEngine.screenshot.lastScreenshotAt = project.metadata?.previewImg?.updatedAt ?? null;

            if (cancelled) {
                newEngine.clear();
                return;
            }

            engineRef.current = newEngine;
            setEditorEngine(newEngine);
            currentProjectId.current = project.id;
        };

        void initializeEngine();

        return () => {
            cancelled = true;
        };
    }, [project.id, branches, posthog, project.metadata?.previewImg?.updatedAt]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            setTimeout(() => engineRef.current?.clear(), 0);
        };
    }, []);

    if (!editorEngine) {
        return null;
    }

    return (
        <EditorEngineContext.Provider value={editorEngine}>
            {children}
        </EditorEngineContext.Provider>
    );
};
