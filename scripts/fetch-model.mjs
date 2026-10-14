// Puts the pinned GigaAM v3 files into models/ for electron-builder to bundle.
// Every file is checked against its SHA-256; a mismatch fails the build.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';

const model = JSON.parse(await readFile('src/shared/gigaam-model.json', 'utf8'));
const directory = path.join('models', model.directory);
await mkdir(directory, { recursive: true });

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const valid = async (file, expected) => (await stat(file).then(info => info.size, () => -1)) === expected.size && await sha256(file) === expected.sha;

for (const file of model.files) {
  const target = path.join(directory, file.name);
  if (await valid(target, file)) continue;
  const partial = target + '.part';
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.name}`, { signal: AbortSignal.timeout(900_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const out = createWriteStream(partial);
      try { for await (const chunk of response.body) if (!out.write(chunk)) await once(out, 'drain'); }
      finally { out.end(); await once(out, 'close'); }
      if (!await valid(partial, file)) throw new Error('size or SHA-256 mismatch');
      await rename(partial, target);
      console.log(`Fetched ${file.name}`);
      break;
    } catch (error) {
      await rm(partial, { force: true });
      if (attempt >= 5) throw new Error(`GigaAM ${file.name}: ${error.message}`);
      console.warn(`GigaAM ${file.name}: ${error.message}; retrying`);
      await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
    }
  }
}
console.log(`GigaAM v3 ready in ${directory}`);
