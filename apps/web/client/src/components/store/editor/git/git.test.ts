import { describe, expect, it } from 'bun:test';

import { parseGitPorcelainStatus } from './git';

describe('parseGitPorcelainStatus', () => {
    it('parses staged, unstaged, and untracked files', () => {
        const raw = ['M  app/page.tsx', ' M components/card.tsx', '?? lib/new.ts', ''].join('\0');

        expect(parseGitPorcelainStatus(raw)).toEqual([
            {
                path: 'app/page.tsx',
                index: 'M',
                worktree: ' ',
                staged: true,
                untracked: false,
            },
            {
                path: 'components/card.tsx',
                index: ' ',
                worktree: 'M',
                staged: false,
                untracked: false,
            },
            {
                path: 'lib/new.ts',
                index: '?',
                worktree: '?',
                staged: false,
                untracked: true,
            },
        ]);
    });

    it('skips rename source records', () => {
        const raw = ['R  app/new.tsx', 'app/old.tsx', ''].join('\0');

        expect(parseGitPorcelainStatus(raw)).toEqual([
            {
                path: 'app/new.tsx',
                index: 'R',
                worktree: ' ',
                staged: true,
                untracked: false,
            },
        ]);
    });
});
