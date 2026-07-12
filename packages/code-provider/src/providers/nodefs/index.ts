import {
    Provider,
    ProviderBackgroundCommand,
    ProviderFileWatcher,
    ProviderTask,
    ProviderTerminal,
    type CopyFileOutput,
    type CopyFilesInput,
    type CreateDirectoryInput,
    type CreateDirectoryOutput,
    type CreateProjectInput,
    type CreateProjectOutput,
    type CreateSessionInput,
    type CreateSessionOutput,
    type CreateTerminalInput,
    type CreateTerminalOutput,
    type DeleteFilesInput,
    type DeleteFilesOutput,
    type DownloadFilesInput,
    type DownloadFilesOutput,
    type GetTaskInput,
    type GetTaskOutput,
    type GitStatusInput,
    type GitStatusOutput,
    type InitializeInput,
    type InitializeOutput,
    type ListFilesInput,
    type ListFilesOutput,
    type ListProjectsInput,
    type ListProjectsOutput,
    type PauseProjectInput,
    type PauseProjectOutput,
    type ReadFileInput,
    type ReadFileOutput,
    type RenameFileInput,
    type RenameFileOutput,
    type SetupInput,
    type SetupOutput,
    type StatFileInput,
    type StatFileOutput,
    type StopProjectInput,
    type StopProjectOutput,
    type TerminalBackgroundCommandInput,
    type TerminalBackgroundCommandOutput,
    type TerminalCommandInput,
    type TerminalCommandOutput,
    type WatchEvent,
    type WatchFilesInput,
    type WatchFilesOutput,
    type WriteFileInput,
    type WriteFileOutput,
} from '../../types';

export interface NodeFsProviderOptions {
    baseUrl?: string;
}

export class NodeFsProvider extends Provider {
    private readonly options: NodeFsProviderOptions;
    private baseUrl: string;

    constructor(options: NodeFsProviderOptions) {
        super();
        this.options = options;
        this.baseUrl = options.baseUrl ?? '';
    }

    async initialize(input: InitializeInput): Promise<InitializeOutput> {
        if (!this.baseUrl && typeof window !== 'undefined') {
            this.baseUrl = window.location.origin;
        }
        return {};
    }

    async writeFile(input: WriteFileInput): Promise<WriteFileOutput> {
        return this.request<WriteFileOutput>('writeFile', input.args);
    }

    async renameFile(input: RenameFileInput): Promise<RenameFileOutput> {
        return this.request<RenameFileOutput>('renameFile', input.args);
    }

    async statFile(input: StatFileInput): Promise<StatFileOutput> {
        return this.request<StatFileOutput>('statFile', input.args);
    }

    async deleteFiles(input: DeleteFilesInput): Promise<DeleteFilesOutput> {
        return this.request<DeleteFilesOutput>('deleteFiles', input.args);
    }

    async listFiles(input: ListFilesInput): Promise<ListFilesOutput> {
        return this.request<ListFilesOutput>('listFiles', input.args);
    }

    async readFile(input: ReadFileInput): Promise<ReadFileOutput> {
        const output = await this.request<ReadFileOutput>('readFile', input.args);
        output.file.toString = () =>
            typeof output.file.content === 'string' ? output.file.content : '';
        return output;
    }

    async downloadFiles(input: DownloadFilesInput): Promise<DownloadFilesOutput> {
        return {
            url: '',
        };
    }

    async copyFiles(input: CopyFilesInput): Promise<CopyFileOutput> {
        return this.request<CopyFileOutput>('copyFiles', input.args);
    }

    async createDirectory(input: CreateDirectoryInput): Promise<CreateDirectoryOutput> {
        return this.request<CreateDirectoryOutput>('createDirectory', input.args);
    }

    async watchFiles(input: WatchFilesInput): Promise<WatchFilesOutput> {
        return {
            watcher: new NodeFsFileWatcher(),
        };
    }

    async createTerminal(input: CreateTerminalInput): Promise<CreateTerminalOutput> {
        return {
            terminal: new NodeFsTerminal(),
        };
    }

    async getTask(input: GetTaskInput): Promise<GetTaskOutput> {
        return {
            task: new NodeFsTask(),
        };
    }

    async runCommand({ args }: TerminalCommandInput): Promise<TerminalCommandOutput> {
        const response = await this.request<TerminalCommandOutput>(
            'run',
            { command: args.command },
            'git',
        );
        return {
            output: response.output ?? '',
        };
    }

    async runBackgroundCommand(
        input: TerminalBackgroundCommandInput,
    ): Promise<TerminalBackgroundCommandOutput> {
        return {
            command: new NodeFsCommand(),
        };
    }

    async gitStatus(input: GitStatusInput): Promise<GitStatusOutput> {
        const response = await this.request<{ raw: string }>('status', {}, 'git');
        return {
            changedFiles: parsePorcelainStatusPaths(response.raw ?? ''),
        };
    }

    async setup(input: SetupInput): Promise<SetupOutput> {
        return {};
    }

    async createSession(input: CreateSessionInput): Promise<CreateSessionOutput> {
        return {};
    }

    async reload(): Promise<boolean> {
        await this.request<Record<string, never>>('restart', {});
        return true;
    }

    async reconnect(): Promise<void> {
        // TODO: Implement
    }

    async ping(): Promise<boolean> {
        return true;
    }

    static async createProject(input: CreateProjectInput): Promise<CreateProjectOutput> {
        return {
            id: input.id,
        };
    }

    static async createProjectFromGit(input: {
        repoUrl: string;
        branch: string;
    }): Promise<CreateProjectOutput> {
        throw new Error('createProjectFromGit not implemented for NodeFs provider');
    }

    async pauseProject(input: PauseProjectInput): Promise<PauseProjectOutput> {
        return {};
    }

    async stopProject(input: StopProjectInput): Promise<StopProjectOutput> {
        return {};
    }

    async listProjects(input: ListProjectsInput): Promise<ListProjectsOutput> {
        return {};
    }

    async destroy(): Promise<void> {
        // TODO: Implement
    }

    private async request<T>(
        action: string,
        args: Record<string, unknown>,
        endpoint: 'fs' | 'git' = 'fs',
    ): Promise<T> {
        if (!this.baseUrl) {
            throw new Error('NodeFs provider base URL is not configured');
        }

        const body =
            endpoint === 'git'
                ? JSON.stringify({ action, ...args })
                : JSON.stringify({ action, args });

        const response = await fetch(`${this.baseUrl}/api/local-preview/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        });

        if (!response.ok) {
            throw new Error(await response.text());
        }

        return response.json() as Promise<T>;
    }
}

export function parsePorcelainStatusPaths(raw: string): string[] {
    return parsePorcelainStatusEntries(raw).map((entry) => entry.path);
}

export interface PorcelainStatusEntry {
    path: string;
    index: string;
    worktree: string;
}

export function parsePorcelainStatusEntries(raw: string): PorcelainStatusEntry[] {
    const records = raw.split('\0').filter(Boolean);
    const entries: PorcelainStatusEntry[] = [];

    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (!record || record.length < 3) {
            continue;
        }

        const index = record[0] ?? ' ';
        const worktree = record[1] ?? ' ';
        const path = record.slice(3);

        if (!path) {
            continue;
        }

        entries.push({ path, index, worktree });

        if (index === 'R' || index === 'C') {
            i++;
        }
    }

    return entries;
}

export class NodeFsFileWatcher extends ProviderFileWatcher {
    start(input: WatchFilesInput): Promise<void> {
        return Promise.resolve();
    }

    stop(): Promise<void> {
        return Promise.resolve();
    }

    registerEventCallback(callback: (event: WatchEvent) => Promise<void>): void {
        // TODO: Implement
    }
}

export class NodeFsTerminal extends ProviderTerminal {
    get id(): string {
        return 'unimplemented';
    }

    get name(): string {
        return 'unimplemented';
    }

    open(): Promise<string> {
        return Promise.resolve('');
    }

    write(): Promise<void> {
        return Promise.resolve();
    }

    run(): Promise<void> {
        return Promise.resolve();
    }

    kill(): Promise<void> {
        return Promise.resolve();
    }

    onOutput(callback: (data: string) => void): () => void {
        return () => {};
    }
}

export class NodeFsTask extends ProviderTask {
    get id(): string {
        return 'unimplemented';
    }

    get name(): string {
        return 'unimplemented';
    }

    get command(): string {
        return 'unimplemented';
    }

    open(): Promise<string> {
        return Promise.resolve('');
    }

    run(): Promise<void> {
        return Promise.resolve();
    }

    restart(): Promise<void> {
        return Promise.resolve();
    }

    stop(): Promise<void> {
        return Promise.resolve();
    }

    onOutput(callback: (data: string) => void): () => void {
        return () => {};
    }
}

export class NodeFsCommand extends ProviderBackgroundCommand {
    get name(): string {
        return 'unimplemented';
    }

    get command(): string {
        return 'unimplemented';
    }

    open(): Promise<string> {
        return Promise.resolve('');
    }

    restart(): Promise<void> {
        return Promise.resolve();
    }

    kill(): Promise<void> {
        return Promise.resolve();
    }

    onOutput(callback: (data: string) => void): () => void {
        return () => {};
    }
}
