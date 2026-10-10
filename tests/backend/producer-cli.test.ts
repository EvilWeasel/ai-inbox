import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

test('portable producer protects credentials, final-only delivery and retry identity', () => {
  execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests/producer'], {
    cwd: resolve(import.meta.dirname, '../..'), stdio: 'pipe', timeout: 15_000,
  });
});
