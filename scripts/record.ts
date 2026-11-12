// Re-record OpenStreetMap fixtures from the LIVE services (slow: Overpass can take minutes). Usage: npm run test:record
import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, ['--test', '--test-timeout=1500000', 'test/e2e.test.ts'], { stdio: 'inherit', env: { ...process.env, RECORD: '1' } });
process.exitCode = r.status ?? 1;
