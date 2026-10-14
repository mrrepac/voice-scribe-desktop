import test from 'node:test';
import assert from 'node:assert/strict';
import { capturedHotkey, hotkeyLabel, isHotkey } from '../src/shared/hotkeys';

const press = (key: number, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; win?: boolean } = {}) =>
  ({ key, ctrl: false, alt: false, shift: false, win: false, ...mods });

test('captured keys become canonical shortcuts', () => {
  assert.deepEqual(capturedHotkey(press(0x78)), { hotkey: 'key:120' });
  assert.deepEqual(capturedHotkey(press(0x52, { win: true, ctrl: true })), { hotkey: 'key:ctrl+win+82' });
  assert.deepEqual(capturedHotkey(press(0x44, { ctrl: true, shift: true })), { hotkey: 'key:ctrl+shift+68' });
  assert.deepEqual(capturedHotkey(press(0x20, { ctrl: true })), { hotkey: 'ctrl-space' });
  assert.deepEqual(capturedHotkey(press(0x20, { ctrl: true, alt: true })), { hotkey: 'ctrl-alt-space' });
  assert.deepEqual(capturedHotkey(press(0x2d)), { hotkey: 'insert' });
  assert.deepEqual(capturedHotkey(press(0x78, { shift: true })), { hotkey: 'key:shift+120' });
});

test('shortcuts that would break typing or other commands are rejected', () => {
  for (const key of [press(0x41), press(0x41, { shift: true }), press(0x20), press(0x0d), press(0x1b, { ctrl: true }), press(0x56, { ctrl: true, alt: true }), press(0xa2)])
    assert.ok('error' in capturedHotkey(key), JSON.stringify(key));
  for (const value of ['key:65', 'key:27', 'key:alt+ctrl+120', 'key:win+shift+120', 'key:ctrl+162', 'key:1200', 'key:', 'toString']) assert.equal(isHotkey(value), false, value);
  assert.equal(isHotkey('key:alt+65'), true);
});

test('labels name the keys', () => {
  assert.equal(hotkeyLabel('key:ctrl+alt+120'), 'Ctrl + Alt + F9');
  assert.equal(hotkeyLabel('key:ctrl+shift+68'), 'Ctrl + Shift + D');
  assert.equal(hotkeyLabel('key:20'), 'CapsLock');
  assert.equal(hotkeyLabel('insert'), 'Insert');
});
