import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { UpdateService } from '../src/main/updates';

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checks = 0;
  downloads = 0;
  installs = 0;
  async checkForUpdates() { this.checks++; this.emit('update-available', { version: '0.3.0' }); return null; }
  async downloadUpdate() { this.downloads++; this.emit('update-downloaded', { version: '0.3.0' }); return []; }
  quitAndInstall() { this.installs++; }
}
const service = (fake: FakeUpdater, busy = () => false, supported = true) => new UpdateService(fake as unknown as ConstructorParameters<typeof UpdateService>[0], supported, busy, () => {});

test('background updates download without restarting; active work blocks installation', async () => {
  const fake = new FakeUpdater();
  let busy = false;
  const updates = service(fake, () => busy);
  await updates.check(true);
  assert.equal(updates.state.phase, 'ready');
  assert.equal(fake.downloads, 1);
  assert.equal(fake.installs, 0);
  assert.equal(fake.autoInstallOnAppQuit, false);
  busy = true;
  assert.throws(() => updates.install(), /завершите/);
  assert.equal(fake.installs, 0);
  busy = false;
  updates.install();
  assert.equal(fake.installs, 1);
});

test('portable builds and busy background checks do not make update requests', async () => {
  const fake = new FakeUpdater();
  await service(fake, () => false, false).check();
  await service(fake, () => true).check(true);
  assert.equal(fake.checks, 0);
});

test('manual check allows downloading explicitly and protects the downloaded state', async () => {
  const fake = new FakeUpdater();
  const updates = service(fake);
  await updates.check();
  assert.equal(updates.state.phase, 'available');
  assert.equal(fake.downloads, 0);
  assert.throws(() => updates.install(), /не загружено/);
  await updates.download();
  await updates.check();
  assert.equal(fake.checks, 1);
  assert.equal(updates.state.phase, 'ready');
});

test('failed check is recoverable without exposing server errors', async () => {
  const fake = new FakeUpdater();
  const updates = service(fake);
  fake.checkForUpdates = async () => { throw new Error('private server details'); };
  await updates.check();
  assert.equal(updates.state.phase, 'error');
  assert.doesNotMatch(updates.state.message, /private/);
  fake.checkForUpdates = async () => { fake.emit('update-not-available'); return null; };
  await updates.check();
  assert.equal(updates.state.phase, 'current');
});
