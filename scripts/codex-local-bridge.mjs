#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';

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
        const child = spawn(command, [...getCodexArgs(), prompt], {
            cwd: bridgeEnv.CODEX_LOCAL_WORKDIR || process.cwd(),
            env: bridgeEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`Codex timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => stdout += chunk);
        child.stderr.on('data', chunk => stderr += chunk);
        child.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', code => {
            clearTimeout(timer);
            const cleanStdout = stripAnsi(stdout).trim();
            const cleanStderr = stripAnsi(stderr).trim();
            const output = cleanStderr || cleanStdout || `Codex exited with code ${code}`;
            if (isCodexLoginOutput(output)) {
                reject(new Error('Codex CLI is not authenticated for non-interactive use. Run Codex once in a real terminal with an API key, or set CODEX_LOCAL_COMMAND to a non-interactive Codex-compatible command.'));
                return;
            }
            if (code === 0 && stdout.trim()) {
                resolve({ text: stdout.trim() });
                return;
            }
            reject(new Error(output));
        });
    });
}

function getCodexArgs() {
    const args = ['-q'];
    if (bridgeEnv.CODEX_LOCAL_PROVIDER) {
        args.push('--provider', bridgeEnv.CODEX_LOCAL_PROVIDER);
    }
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
