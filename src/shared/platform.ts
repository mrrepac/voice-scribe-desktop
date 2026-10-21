/** macOS; the sandboxed renderer has no `process`, so it asks the browser. */
export const IS_MAC = typeof process !== 'undefined' && typeof process.platform === 'string'
  ? process.platform === 'darwin'
  : typeof navigator !== 'undefined' && /^Mac/.test(navigator.platform);
