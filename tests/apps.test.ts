import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { normalizeApp, parseApps } from '../src/shared/apps';

test('program names normalize to lower-case executables', () => {
  assert.equal(normalizeApp(' Telegram '), 'telegram.exe');
  assert.equal(normalizeApp('C:\\Apps\\Code.EXE'), 'code.exe');
  assert.equal(normalizeApp('bad|name'), '');
  assert.deepEqual(parseApps('telegram\n\nTelegram.exe\r\nslack.exe, discord'), ['telegram.exe', 'slack.exe', 'discord.exe']);
});
