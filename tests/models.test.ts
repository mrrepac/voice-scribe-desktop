import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { ModelStore, whisperModelOf } from '../src/main/models';

const turbo = 'huggingface.co_onnx-community_whisper-large-v3-turbo_resolve_main_';

test('cache file names map to the model they belong to', () => {
  assert.equal(whisperModelOf(`${turbo}onnx_encoder_model_q4.onnx`), 'turbo');
  assert.equal(whisperModelOf(`${turbo}config.json`), 'turbo');
  assert.equal(whisperModelOf(`${turbo}onnx_encoder_model_fp16.onnx`), 'turbo-hq');
  assert.equal(whisperModelOf(`${turbo}onnx_encoder_model_fp16.onnx.1234.tmp`), 'turbo-hq');
  assert.equal(whisperModelOf('huggingface.co_onnx-community_whisper-small_resolve_main_onnx_encoder_model_quantized.onnx'), 'small');
  assert.equal(whisperModelOf('settings.json'), null);
});

test('models are listed by group and deleted without touching others or the plugin cache', async () => {
  const root = await mkdtemp(path.resolve('.test-build/models-'));
  try {
    const models = path.join(root, 'models');
    const legacy = path.join(root, 'legacy');
    await mkdir(path.join(models, 'gigaam-v3-punct'), { recursive: true });
    await mkdir(path.join(models, 'speakers'), { recursive: true });
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(models, `${turbo}onnx_encoder_model_q4.onnx`), Buffer.alloc(300));
    await writeFile(path.join(models, `${turbo}config.json`), Buffer.alloc(20));
    await writeFile(path.join(models, `${turbo}onnx_encoder_model_fp16.onnx`), Buffer.alloc(700));
    await writeFile(path.join(models, 'gigaam-v3-punct', 'encoder.int8.onnx'), Buffer.alloc(200));
    await writeFile(path.join(models, 'speakers', 'embedding.onnx'), Buffer.alloc(100));
    await writeFile(path.join(legacy, `${turbo}onnx_encoder_model_q4.onnx`), Buffer.alloc(50));
    await writeFile(path.join(legacy, 'unrelated.txt'), Buffer.alloc(9));
    const store = new ModelStore(models, legacy);
    assert.deepEqual(await store.list(), [
      { id: 'turbo', name: 'Whisper Turbo', bytes: 320, removable: true },
      { id: 'turbo-hq', name: 'Whisper Turbo HQ · fp16-энкодер', bytes: 700, removable: true },
      { id: 'gigaam', name: 'GigaAM v3', bytes: 200, removable: true },
      { id: 'speakers', name: 'Определение ораторов', bytes: 100, removable: true },
      { id: 'legacy', name: 'Кэш плагина Obsidian', bytes: 50, removable: false },
    ]);
    await store.remove('turbo');
    assert.deepEqual((await readdir(models)).filter(name => name.startsWith(turbo)), [`${turbo}onnx_encoder_model_fp16.onnx`]);
    await store.remove('gigaam');
    assert.deepEqual(await readdir(path.join(models, 'gigaam-v3-punct')), []);
    assert.equal((await readdir(legacy)).length, 2, 'the plugin cache is read-only');
    await assert.rejects(store.remove('legacy'), /Неизвестная модель/);
    await assert.rejects(store.remove('../settings'), /Неизвестная модель/);
    assert.deepEqual((await store.list()).map(entry => entry.id), ['turbo-hq', 'speakers', 'legacy']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a missing models directory lists nothing', async () => {
  assert.deepEqual(await new ModelStore(path.resolve('.test-build/no-such-models')).list(), []);
});
