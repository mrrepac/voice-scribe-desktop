import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { WHISPER_REVISIONS, whisperCacheKey, whisperFileUrl } from '../src/shared/whisper';
import { cacheFilename } from '../src/main/storage';
import { whisperModelOf } from '../src/main/models';

test('every Whisper repository is pinned to a full commit', () => {
  for (const id of ['tiny', 'base', 'small', 'large-v3-turbo']) assert.match(WHISPER_REVISIONS[`onnx-community/whisper-${id}`], /^[0-9a-f]{40}$/);
  assert.equal(whisperFileUrl('onnx-community/whisper-tiny', 'config.json'), 'https://huggingface.co/onnx-community/whisper-tiny/resolve/ff4177021cc41f7db950912b73ea4fdf7d01d8e7/config.json');
});

test('pinned downloads reuse files cached from main; other commits get their own keys', () => {
  const pinned = whisperFileUrl('onnx-community/whisper-large-v3-turbo', 'onnx/encoder_model_fp16.onnx');
  assert.equal(whisperCacheKey(pinned), 'https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/onnx/encoder_model_fp16.onnx');
  const later = 'https://huggingface.co/onnx-community/whisper-tiny/resolve/0123456789abcdef0123456789abcdef01234567/config.json';
  assert.equal(whisperCacheKey(later), later);
  assert.equal(cacheFilename(later), 'huggingface.co_onnx-community_whisper-tiny_resolve_0123456789abcdef0123456789abcdef01234567_config.json');
  assert.throws(() => cacheFilename('https://huggingface.co/onnx-community/whisper-tiny/resolve/feature/config.json'));
  assert.equal(whisperModelOf(cacheFilename(later.replace('whisper-tiny', 'whisper-large-v3-turbo').replace('config.json', 'onnx/encoder_model_fp16.onnx'))), 'turbo-hq');
});
