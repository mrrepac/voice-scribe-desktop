/**
 * Whisper repositories are loaded at a fixed commit, so a change upstream cannot
 * silently alter or break recognition. Update a pin only after checking the model.
 */
export const WHISPER_REVISIONS: Record<string, string> = {
  'onnx-community/whisper-tiny': 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
  'onnx-community/whisper-base': '1846881b6b3a3024392c1eea3ad983695bc23925',
  'onnx-community/whisper-small': '36050c46d777d46dc4b5f43f6d90574fc38f8732',
  'onnx-community/whisper-large-v3-turbo': '360ebcde2559d60bb474678be3c1de9ef347d01a',
};

/**
 * Before pinning, files were downloaded from `main`, which pointed at these commits.
 * Their existing cache entries (and the Obsidian plugin's cache) stay valid.
 * Never add a new commit here: a later pin must get its own cache keys.
 */
const CACHED_AS_MAIN = new Set([
  'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
  '1846881b6b3a3024392c1eea3ad983695bc23925',
  '36050c46d777d46dc4b5f43f6d90574fc38f8732',
  '360ebcde2559d60bb474678be3c1de9ef347d01a',
]);

/** Cache key for a model file URL: the URL itself, or its historic `main` form. */
export function whisperCacheKey(url: string): string {
  return url.replace(/\/resolve\/([0-9a-f]{40})\//, (match, sha: string) => CACHED_AS_MAIN.has(sha) ? '/resolve/main/' : match);
}

export function whisperFileUrl(modelId: string, file: string): string {
  return `https://huggingface.co/${modelId}/resolve/${WHISPER_REVISIONS[modelId] ?? 'main'}/${file}`;
}
