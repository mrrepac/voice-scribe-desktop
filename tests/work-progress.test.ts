import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkProgress } from '../src/shared/work-progress';

test('ETA uses completed work and does not restart on repeated token updates', () => {
  const work = new WorkProgress();
  work.reset(0);
  work.update(0, 1000);
  assert.equal(work.remaining(1000), undefined);
  work.update(25, 10000);
  assert.equal(work.remaining(10000), 30);
  work.update(25, 15000);
  assert.equal(work.remaining(15000), 25);
  work.update(10, 16000);
  assert.equal(work.percent, 25);
  assert.equal(work.remaining(41000), undefined);
  work.update(50, 42000);
  assert.equal(work.remaining(42000), 42);
  work.reset(43000);
  assert.equal(work.percent, undefined);
  assert.equal(work.remaining(43000), undefined);
});

test('ETA waits for a useful sample and ignores invalid percentages', () => {
  const work = new WorkProgress();
  work.reset(0);
  work.update(20, 1000);
  work.update(NaN, 6000);
  work.update(undefined, 6000);
  assert.equal(work.remaining(6000), undefined);
  work.update(40, 10000);
  assert.equal(work.remaining(10000), 15);
});
