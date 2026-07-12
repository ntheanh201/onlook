import { describe, expect, it } from 'bun:test';

import { parsePorcelainStatusEntries, parsePorcelainStatusPaths } from './index';

describe('NodeFs git porcelain parser', () => {
    it('parses changed paths from NUL-separated porcelain v1 output', () => {
        const raw = [
            ' M app/page.tsx',
            'A  components/button.tsx',
            '?? lib/new file.ts',
            '',
        ].join('\0');

        expect(parsePorcelainStatusPaths(raw)).toEqual([
            'app/page.tsx',
            'components/button.tsx',
            'lib/new file.ts',
        ]);
    });

    it('preserves index and worktree status characters', () => {
        const raw = ['MM app/page.tsx', '?? new.tsx', ' D deleted.tsx', ''].join('\0');

        expect(parsePorcelainStatusEntries(raw)).toEqual([
            { path: 'app/page.tsx', index: 'M', worktree: 'M' },
            { path: 'new.tsx', index: '?', worktree: '?' },
            { path: 'deleted.tsx', index: ' ', worktree: 'D' },
        ]);
    });

    it('skips rename destination records', () => {
        const raw = ['R  new-name.tsx', 'old-name.tsx', ''].join('\0');

        expect(parsePorcelainStatusPaths(raw)).toEqual(['new-name.tsx']);
    });
});
