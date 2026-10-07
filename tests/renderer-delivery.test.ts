import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { deliveryMessage } from '../src/renderer/delivery-message';

test('paste accepted without Enter never claims Enter was sent', () => {
  const text = deliveryMessage({ status: 'inserted', entered: false, reason: 'target-changed' }, true, true);
  assert.match(text, /Enter не отправлен/);
  assert.match(text, /окно изменилось/);
  assert.doesNotMatch(text, /поле с Enter/);
});
test('successful explicit finish can report Enter and never expose protocol keys', () => {
  assert.match(deliveryMessage({ status: 'inserted', entered: true }, true, true), /с Enter/);
  for (const reason of ['target-changed', 'modifiers-held', 'input-blocked', 'unknown-protocol-key']) {
    const text = deliveryMessage({ status: 'clipboard-only', reason }, true, false);
    assert.doesNotMatch(text, new RegExp(reason));
    assert.match(text, /Ctrl \+ V/);
  }
});
test('UI microphone and file results describe clipboard-only mode without warning', () => {
  assert.equal(deliveryMessage({ status: 'clipboard-only', reason: 'no-target' }, false, false), 'Текст скопирован в буфер обмена. Вставьте его с помощью Ctrl + V.');
});
