import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Log } from '../src/main/log';

test('log lines are appended and the file rotates at 1 MB', async () => {
  const root = await mkdtemp(path.resolve('.test-build/log-'));
  try {
    const log = new Log(path.join(root, 'logs'));
    log.write('ERROR', 'Clipboard restore failed', new Error('busy'));
    const first = await readFile(log.file, 'utf8');
    assert.match(first, /^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR Clipboard restore failed Error: busy\n\s+at /);
    const chunk = 'x'.repeat(100_000);
    for (let i = 0; i < 12; i++) log.write('WARN', chunk);
    assert.ok((await stat(path.join(root, 'logs', 'main.old.log'))).size > 0);
    assert.ok((await stat(log.file)).size <= 1024 * 1024);
    // A reopened log continues the same file and size accounting.
    const before = (await stat(log.file)).size;
    new Log(path.join(root, 'logs')).write('INFO', 'started');
    assert.ok((await stat(log.file)).size > before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unwritable log location never throws', () => {
  const log = new Log(path.resolve('.test-build/missing\0dir'));
  assert.doesNotThrow(() => log.write('ERROR', 'lost'));
});
