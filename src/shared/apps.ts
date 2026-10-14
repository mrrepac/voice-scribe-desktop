/** Executable names compare case-insensitively; "Telegram" and "telegram.exe" are the same program. */
export function normalizeApp(value: string): string {
  const name = value.trim().split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (!name || name.length > 100 || /[<>:"|?*\u0000-\u001f]/.test(name)) return '';
  return name.endsWith('.exe') ? name : `${name}.exe`;
}

/** One program per line; blank lines and duplicates are dropped. */
export function parseApps(raw: string): string[] {
  return [...new Set(raw.split(/[\r\n,;]+/).map(normalizeApp).filter(Boolean))];
}
