import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DictationGesture } from '../src/renderer/gesture';

test('tap starts, release preserves recording, second tap stops', () => {
  const keys = new DictationGesture();
  assert.equal(keys.down('idle', 1), 'start');
  assert.equal(keys.up(120, 1), false);
  assert.equal(keys.down('recording', 1), 'stop');
  assert.equal(keys.up(650, 1), false);
});
test('hold stops even when microphone is still starting; repeats ignored', () => {
  const keys = new DictationGesture();
  assert.equal(keys.down('idle', 8), 'start');
  assert.equal(keys.down('starting', 8), 'none');
  assert.equal(keys.up(450, 8), true);
});
test('release from a cancelled session never stops another session', () => {
  const keys = new DictationGesture();
  keys.down('idle', 2);
  assert.equal(keys.up(600, 3), false);
  keys.down('idle', 3);
  keys.reset();
  assert.equal(keys.up(600, 3), false);
});
test('busy processing cannot start another recording or own its release', () => {
  const keys = new DictationGesture();
  assert.equal(keys.down('transcribing', 1), 'none');
  assert.equal(keys.up(1000, 1), false);
});
