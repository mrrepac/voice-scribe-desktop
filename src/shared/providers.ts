export const PROVIDERS = [
  { id: 'chadgpt', name: 'ChadGPT', url: 'https://ask.chadgpt.ru/api/v1' },
  { id: 'gptunnel', name: 'GPTunnel', url: 'https://gptunnel.ru/v1' },
  { id: 'polza', name: 'Polza AI', url: 'https://api.polza.ai/api/v1' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com' },
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1' },
  { id: 'ollama', name: 'Ollama (локально)', url: 'http://localhost:11434/v1' },
  { id: 'lmstudio', name: 'LM Studio (локально)', url: 'http://localhost:1234/v1' },
] as const;

export function apiBase(base: string): string {
  let value = base.trim();
  if (value && !/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(value) ? 'http://' : 'https://') + value;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Укажите корректный адрес API.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash)
    throw new Error('API требует HTTPS; HTTP разрешён только для localhost. Не указывайте ключ в адресе.');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, '');
  return url.toString().replace(/\/+$/, '');
}
export function providerFor(base: string) {
  try { const normalized = apiBase(base); return PROVIDERS.find(p => p.url === normalized); } catch { return undefined; }
}
