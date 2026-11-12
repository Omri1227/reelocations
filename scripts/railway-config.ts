#!/usr/bin/env node
/**
 * `railway config <plan|apply|…>` that also works on Windows.
 *
 *   npm run railway:plan            (= node scripts/railway-config.ts plan)
 *
 * Why: the `railway` npm SDK (railway/iac) checks the CLI version by running the executable named in the `_`
 * environment variable, or plain `railway`. On Windows an npm-installed CLI is a `.cmd`/`.ps1` wrapper that Node cannot
 * start without a shell, and Git Bash sets `_` to a POSIX path, so the check fails with "requires Railway CLI 5.42.1
 * or newer" even on a current CLI. This wrapper finds the real binary and passes it in `_`.
 * Set RAILWAY_CLI_BIN to override the binary path.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function findCli(): string {
  if (process.env.RAILWAY_CLI_BIN) return process.env.RAILWAY_CLI_BIN;
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@railway', 'cli', 'bin', 'railway.exe'),
      path.join(process.env.USERPROFILE ?? '', 'scoop', 'shims', 'railway.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'railway', 'railway.exe'),
    ];
    const hit = candidates.find((c) => c && fs.existsSync(c));
    if (hit) return hit;
  }
  return 'railway';
}

const bin = findCli();
const args = process.argv.slice(2);
const r = spawnSync(bin, ['config', ...(args.length ? args : ['plan'])], { stdio: 'inherit', env: { ...process.env, _: bin } });
if (r.error) { console.error(`could not start the Railway CLI (${bin}): ${r.error.message}. Install it or set RAILWAY_CLI_BIN.`); process.exit(1); }
process.exit(r.status ?? 1);
