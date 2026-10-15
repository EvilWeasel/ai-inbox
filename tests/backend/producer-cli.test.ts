import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

test('portable producer protects credentials, final-only delivery and retry identity', () => {
  execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests/producer'], {
    // This runs the entire producer suite, including fsync and real subprocess
    // fixtures. Keep a finite suite budget without imposing a unit-test budget.
    cwd: resolve(import.meta.dirname, '../..'), stdio: 'pipe', timeout: 120_000,
  });
});
