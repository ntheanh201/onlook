import { useEditorEngine } from '@/components/store/editor';
import type { GitFileStatus } from '@/components/store/editor/git/git';
import { Button } from '@onlook/ui/button';
import { Icons } from '@onlook/ui/icons';
import { Input } from '@onlook/ui/input';
import { cn } from '@onlook/ui/utils';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { CodeDiff } from '../../../right-panel/chat-tab/code-display/code-diff';

type DiffContent = {
    original: string;
    modified: string;
};

const getStatusLetter = (file: GitFileStatus) => {
    if (file.untracked) {
        return 'U';
    }
    if (file.index === 'A' || file.worktree === 'A') {
        return 'A';
    }
    if (file.index === 'D' || file.worktree === 'D') {
        return 'D';
    }
    if (file.index === 'R' || file.worktree === 'R') {
        return 'R';
    }
    return 'M';
};

const SourceFileRow = ({
    file,
    selected,
    stagedGroup,
    onSelect,
    onStage,
    onUnstage,
    onDiscard,
}: {
    file: GitFileStatus;
    selected: boolean;
    stagedGroup: boolean;
    onSelect: () => void;
    onStage: () => void;
    onUnstage: () => void;
    onDiscard: () => void;
}) => (
    <div
        role="button"
        tabIndex={0}
        className={cn(
            'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
            selected ? 'bg-accent text-foreground' : 'text-foreground-secondary hover:bg-accent/50 hover:text-foreground',
        )}
        onClick={onSelect}
        onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect();
            }
        }}
    >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border text-[10px] text-muted-foreground">
            {getStatusLetter(file)}
        </span>
        <span className="min-w-0 flex-1 truncate">{file.path}</span>
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            {stagedGroup ? (
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(event) => {
                        event.stopPropagation();
                        onUnstage();
                    }}
                    title="Unstage file"
                >
                    <Icons.Minus className="h-3 w-3" />
                </Button>
            ) : (
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(event) => {
                        event.stopPropagation();
                        onStage();
                    }}
                    title="Stage file"
                >
                    <Icons.Plus className="h-3 w-3" />
                </Button>
            )}
            <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={(event) => {
                    event.stopPropagation();
                    onDiscard();
                }}
                title="Discard file"
            >
                <Icons.Trash className="h-3 w-3" />
            </Button>
        </span>
    </div>
);

export const SourceControlTab = observer(() => {
    const editorEngine = useEditorEngine();
    const git = editorEngine.activeSandbox.gitManager;
    const [commitMessage, setCommitMessage] = useState('');
    const [branch, setBranch] = useState('main');
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [diffContent, setDiffContent] = useState<DiffContent | null>(null);
    const [isCommitting, setIsCommitting] = useState(false);

    useEffect(() => {
        void git.getDetailedStatus();
        void git.getCurrentBranch().then(setBranch);
    }, [git]);

    const stagedFiles = useMemo(
        () => git.detailedStatus.filter((file) => file.staged),
        [git.detailedStatus],
    );
    const changedFiles = useMemo(
        () => git.detailedStatus.filter((file) => !file.staged),
        [git.detailedStatus],
    );

    const selectedFile = git.detailedStatus.find((file) => file.path === selectedPath) ?? null;

    const refresh = async () => {
        const status = await git.getDetailedStatus();
        setBranch(await git.getCurrentBranch());
        return status;
    };

    const loadDiff = async (file: GitFileStatus) => {
        setSelectedPath(file.path);
        const originalSource = file.staged ? 'head' : 'index';
        const modifiedSource = file.staged ? 'index' : 'worktree';
        const [original, modified] = await Promise.all([
            file.untracked ? Promise.resolve('') : git.getFileContent(file.path, originalSource),
            git.getFileContent(file.path, modifiedSource),
        ]);
        setDiffContent({ original, modified });
    };

    const mutateFile = async (operation: () => Promise<unknown>) => {
        await operation();
        const status = await refresh();
        if (selectedFile) {
            const nextSelected = status.find((file) => file.path === selectedFile.path);
            if (nextSelected) {
                await loadDiff(nextSelected);
            } else {
                setSelectedPath(null);
                setDiffContent(null);
            }
        }
    };

    const commit = async () => {
        if (!commitMessage.trim()) {
            return;
        }
        setIsCommitting(true);
        try {
            await git.commitStaged(commitMessage);
            setCommitMessage('');
            setSelectedPath(null);
            setDiffContent(null);
            await refresh();
        } finally {
            setIsCommitting(false);
        }
    };

    return (
        <div className="flex h-full w-full flex-col overflow-hidden text-xs">
            <div className="space-y-3 border-b p-3">
                <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                        <div className="text-sm font-medium">Source Control</div>
                        <div className="flex items-center gap-1 truncate text-muted-foreground">
                            <Icons.Branch className="h-3 w-3" />
                            <span className="truncate">{branch}</span>
                        </div>
                    </div>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={refresh}>
                        <Icons.Reload className="h-4 w-4" />
                    </Button>
                </div>
                <div className="flex gap-2">
                    <Input
                        className="h-8 text-xs"
                        placeholder="Commit message"
                        value={commitMessage}
                        onChange={(event) => setCommitMessage(event.target.value)}
                    />
                    <Button
                        className="h-8"
                        disabled={stagedFiles.length === 0 || !commitMessage.trim() || isCommitting}
                        onClick={commit}
                    >
                        Commit
                    </Button>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-2">
                {git.detailedStatus.length === 0 ? (
                    <div className="flex h-24 items-center justify-center text-muted-foreground">
                        {git.isLoadingStatus ? 'Loading changes...' : 'No changes'}
                    </div>
                ) : (
                    <div className="space-y-4">
                        <SourceControlGroup
                            title="Staged Changes"
                            files={stagedFiles}
                            selectedPath={selectedPath}
                            stagedGroup
                            onSelect={loadDiff}
                            onStage={(file) => mutateFile(() => git.stageFile(file.path))}
                            onUnstage={(file) => mutateFile(() => git.unstageFile(file.path))}
                            onDiscard={(file) => mutateFile(() => git.discardFile(file.path))}
                        />
                        <SourceControlGroup
                            title="Changes"
                            files={changedFiles}
                            selectedPath={selectedPath}
                            stagedGroup={false}
                            onSelect={loadDiff}
                            onStage={(file) => mutateFile(() => git.stageFile(file.path))}
                            onUnstage={(file) => mutateFile(() => git.unstageFile(file.path))}
                            onDiscard={(file) => mutateFile(() => git.discardFile(file.path))}
                        />
                    </div>
                )}
            </div>

            <div className="max-h-[45%] min-h-0 border-t">
                {selectedFile && diffContent ? (
                    <div className="flex h-full min-h-0 flex-col">
                        <div className="truncate border-b px-3 py-2 text-muted-foreground">
                            {selectedFile.path}
                        </div>
                        <div className="min-h-0 flex-1 overflow-auto">
                            <CodeDiff
                                originalCode={diffContent.original}
                                modifiedCode={diffContent.modified}
                            />
                        </div>
                    </div>
                ) : (
                    <div className="flex h-28 items-center justify-center px-3 text-center text-xs text-muted-foreground">
                        Select a changed file to inspect its diff.
                    </div>
                )}
            </div>
        </div>
    );
});

const SourceControlGroup = ({
    title,
    files,
    selectedPath,
    stagedGroup,
    onSelect,
    onStage,
    onUnstage,
    onDiscard,
}: {
    title: string;
    files: GitFileStatus[];
    selectedPath: string | null;
    stagedGroup: boolean;
    onSelect: (file: GitFileStatus) => void;
    onStage: (file: GitFileStatus) => void;
    onUnstage: (file: GitFileStatus) => void;
    onDiscard: (file: GitFileStatus) => void;
}) => {
    if (files.length === 0) {
        return null;
    }

    return (
        <section>
            <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {title} ({files.length})
            </div>
            <div className="space-y-1">
                {files.map((file) => (
                    <SourceFileRow
                        key={`${title}-${file.path}`}
                        file={file}
                        selected={selectedPath === file.path}
                        stagedGroup={stagedGroup}
                        onSelect={() => onSelect(file)}
                        onStage={() => onStage(file)}
                        onUnstage={() => onUnstage(file)}
                        onDiscard={() => onDiscard(file)}
                    />
                ))}
            </div>
        </section>
    );
};
