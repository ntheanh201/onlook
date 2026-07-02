#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const host = process.env.CODEX_LOCAL_BRIDGE_HOST || '127.0.0.1';
const port = Number(process.env.CODEX_LOCAL_BRIDGE_PORT || 3987);
const command = process.env.CODEX_LOCAL_COMMAND || 'codex';
const timeoutMs = Number(process.env.CODEX_LOCAL_TIMEOUT_MS || 120000);
const bridgeEnv = {
    ...process.env,
    ...readEnvFile(process.env.CODEX_LOCAL_ENV_FILE || 'apps/web/client/.env'),
};

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, { ok: true });
        return;
    }

    if (req.method !== 'POST' || req.url !== '/chat') {
        sendJson(res, 404, { error: 'Not found' });
        return;
    }

    try {
        const body = await readJson(req);
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt) {
            sendJson(res, 400, { error: 'Missing prompt' });
            return;
        }

        const result = await runCodex(prompt);
        sendJson(res, 200, result);
    } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
});

server.listen(port, host, () => {
    console.log(`Codex local bridge listening on http://${host}:${port}`);
});

function readJson(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
            raw += chunk;
            if (raw.length > 1_000_000) {
                reject(new Error('Request too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

function runCodex(prompt) {
    return new Promise((resolve, reject) => {
        // codex exec streams progress/logs to stdout; -o writes only the final
        // agent message to this file, which we read back for clean output.
        const outputFile = join(tmpdir(), `codex-bridge-${randomUUID()}.txt`);
        const child = spawn(command, [...getCodexArgs(outputFile), prompt], {
            cwd: bridgeEnv.CODEX_LOCAL_WORKDIR || process.cwd(),
            env: bridgeEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            cleanupFile(outputFile);
            reject(new Error(`Codex timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => stdout += chunk);
        child.stderr.on('data', chunk => stderr += chunk);
        child.on('error', error => {
            clearTimeout(timer);
            cleanupFile(outputFile);
            reject(error);
        });
        child.on('close', code => {
            clearTimeout(timer);
            const cleanStdout = stripAnsi(stdout).trim();
            const cleanStderr = stripAnsi(stderr).trim();
            const output = cleanStderr || cleanStdout || `Codex exited with code ${code}`;
            if (isCodexLoginOutput(output)) {
                cleanupFile(outputFile);
                reject(new Error('Codex CLI is not authenticated for non-interactive use. Run `codex login` in a real terminal, or set CODEX_LOCAL_COMMAND to a non-interactive Codex-compatible command.'));
                return;
            }

            let finalMessage = '';
            try {
                if (existsSync(outputFile)) {
                    finalMessage = stripAnsi(readFileSync(outputFile, 'utf8')).trim();
                }
            } catch {
                // ignore read errors, fall back to stdout
            }
            cleanupFile(outputFile);

            const text = finalMessage || cleanStdout;
            if (code === 0 && text) {
                resolve({ text });
                return;
            }
            reject(new Error(output));
        });
    });
}

function cleanupFile(file) {
    try {
        rmSync(file, { force: true });
    } catch {
        // ignore
    }
}

function getCodexArgs(outputFile) {
    // Non-interactive, read-only (chat must not modify files), machine-clean output
    const args = [
        'exec',
        '--sandbox', 'read-only',
        '--skip-git-repo-check',
        '--color', 'never',
        '-o', outputFile,
    ];
    if (bridgeEnv.CODEX_LOCAL_MODEL) {
        args.push('--model', bridgeEnv.CODEX_LOCAL_MODEL);
    }
    return args;
}

function readEnvFile(path) {
    if (!path || !existsSync(path)) {
        return {};
    }

    const env = {};
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex === -1) {
            continue;
        }
        const key = trimmed.slice(0, separatorIndex).trim();
        let value = trimmed.slice(separatorIndex + 1).trim();
        if (!key) {
            continue;
        }
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        env[key] = value;
    }
    return env;
}

function stripAnsi(value) {
    return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function isCodexLoginOutput(value) {
    return value.includes('Sign in with ChatGPT')
        || value.includes('Raw mode is not supported')
        || value.includes('OPENAI_API_KEY environment variable is missing');
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}
