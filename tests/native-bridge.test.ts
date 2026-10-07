import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { NativeBridge } from '../src/main/native';

const executable = path.resolve('native/bin/VoiceScribe.Native.exe');

function waitFor(bridge: NativeBridge, event: 'ready' | 'failure'): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bridge.off(event, receive);
      reject(new Error(`Timed out waiting for native ${event}`));
    }, 9000);
    const receive = (value?: unknown) => {
      clearTimeout(timer);
      resolve(value);
    };
    bridge.once(event, receive);
  });
}

test('native bridge communicates and intentional stop is quiet', {
  skip: process.platform !== 'win32' || !existsSync(executable),
  timeout: 12000,
}, async () => {
  const bridge = new NativeBridge();
  const failures: string[] = [];
  bridge.on('failure', message => failures.push(message));
  try {
    const ready = waitFor(bridge, 'ready');
    bridge.start(executable);
    await ready;
    assert.equal(bridge.ready, true);
    const diagnostics = await bridge.request('diagnostics');
    assert.equal(diagnostics.inputLayoutValid, true);
    assert.equal(diagnostics.keyboardHookInstalled, true);
    const target = await bridge.request('get-target');
    assert.match(target.target, /^\d+$/);
    // No actual window or keyboard injection is involved in this fallback check.
    const result = await bridge.request('insert', { target: '1', enter: true });
    assert.equal(result.status, 'clipboard-only');
    assert.equal(result.entered, false);
    const cancelled = await bridge.request('cancel-insert');
    assert.equal(cancelled.cancelled, false);
    bridge.stop();
    assert.equal(bridge.ready, false);
    await assert.rejects(bridge.request('get-target'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(failures, []);
  } finally { bridge.stop(); }
});

test('native bridge reports spawn failure once and stays unavailable', { timeout: 12000 }, async () => {
  const bridge = new NativeBridge();
  const failures: string[] = [];
  bridge.on('failure', message => failures.push(message));
  try {
    const failed = waitFor(bridge, 'failure');
    bridge.start(path.resolve('native/bin/intentionally-missing-helper.exe'));
    await failed;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(failures.length, 1);
    assert.equal(bridge.ready, false);
    await assert.rejects(bridge.request('diagnostics'));
  } finally { bridge.stop(); }
});

test('native bridge detects an unexpected helper exit', {
  skip: process.platform !== 'win32' || !existsSync(executable),
  timeout: 12000,
}, async () => {
  const bridge = new NativeBridge();
  try {
    const ready = waitFor(bridge, 'ready');
    bridge.start(executable);
    await ready;
    const failed = waitFor(bridge, 'failure');
    await bridge.request('quit');
    await failed;
    assert.equal(bridge.ready, false);
    await assert.rejects(bridge.request('get-target'));
  } finally { bridge.stop(); }
});
