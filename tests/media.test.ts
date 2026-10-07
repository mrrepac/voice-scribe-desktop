import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { mediaResponse } from '../src/main/media';

test('source files are served whole or by byte range for seeking', async () => {
  const directory = await mkdtemp(path.resolve('.test-build/media-'));
  try {
    const file = path.join(directory, 'talk.mp3');
    await writeFile(file, Buffer.from('0123456789'));
    const whole = await mediaResponse(file, null);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'audio/mpeg');
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.equal(await whole.text(), '0123456789');
    const middle = await mediaResponse(file, 'bytes=2-5');
    assert.equal(middle.status, 206);
    assert.equal(middle.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await middle.text(), '2345');
    const open = await mediaResponse(file, 'bytes=7-');
    assert.equal(await open.text(), '789');
    const tail = await mediaResponse(file, 'bytes=-3');
    assert.equal(tail.headers.get('content-range'), 'bytes 7-9/10');
    assert.equal(await tail.text(), '789');
    assert.equal((await mediaResponse(file, 'bytes=4-99')).headers.get('content-range'), 'bytes 4-9/10');
    assert.equal((await mediaResponse(file, 'bytes=20-30')).status, 416);
    assert.equal((await mediaResponse(file, 'bytes=0-1,4-5')).status, 200, 'multiple ranges fall back to the whole file');
    assert.equal((await mediaResponse(path.join(directory, 'gone.mp3'), null)).status, 404);
    assert.equal((await mediaResponse(directory, null)).status, 404);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
