import { build } from 'esbuild';
import { mkdir, copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

// Electron 44 does not download its runtime during npm install. This official
// installer is idempotent and verifies the runtime matches the package version.
execFileSync(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit', windowsHide: true });
execFileSync(process.execPath, ['node_modules/ffmpeg-static/install.js'], { stdio: 'inherit', windowsHide: true });
await mkdir('dist/ort', { recursive: true });
await build({entryPoints:['src/main/index.ts'],outfile:'dist/main.cjs',platform:'node',format:'cjs',bundle:true,external:['electron','electron-updater'],target:'node22'});
await build({entryPoints:['src/main/diarization-worker.ts'],outfile:'dist/diarization-worker.cjs',platform:'node',format:'cjs',bundle:true,external:['sherpa-onnx-node'],target:'node22'});
await build({entryPoints:['src/main/gigaam-worker.ts'],outfile:'dist/gigaam-worker.cjs',platform:'node',format:'cjs',bundle:true,external:['sherpa-onnx-node'],target:'node22'});
await build({entryPoints:['src/main/preload.ts'],outfile:'dist/preload.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node22'});
await build({entryPoints:['src/main/overlay-preload.ts'],outfile:'dist/overlay-preload.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node22'});
await build({entryPoints:['src/renderer/index.ts'],outfile:'dist/renderer.js',platform:'browser',format:'esm',bundle:true,target:'chrome130'});
await build({entryPoints:['src/asr/worker.ts'],outfile:'dist/asr-worker.js',platform:'browser',format:'esm',bundle:true,target:'chrome130',minify:true,define:{'process.release.name':'"browser"'}});
if(process.argv.includes('--smoke')) {
  await build({entryPoints:['src/asr/smoke.ts'],outfile:'dist/smoke.js',platform:'browser',format:'esm',bundle:true,target:'chrome130'});
  if(existsSync('artifacts/fixture.wav'))await copyFile('artifacts/fixture.wav','dist/fixture.wav');
  if(existsSync('artifacts/fixture-ru.wav'))await copyFile('artifacts/fixture-ru.wav','dist/fixture-ru.wav');
}
// Inline only the icons the app uses. No network or icon font is needed at runtime.
const iconNames = {
  mic: 'microphone', history: 'history', settings: 'adjustments-horizontal',
  file: 'file-music', copy: 'copy', arrow: 'arrow-right', search: 'search',
  shield: 'shield-check', download: 'download', stop: 'player-stop', play: 'player-play',
  keyboard: 'keyboard', 'chevron-down': 'chevron-down', tray: 'arrow-down-right',
};
const symbols = await Promise.all(Object.entries(iconNames).map(async ([id, name]) => {
  const svg = await readFile(`node_modules/@tabler/icons/icons/outline/${name}.svg`, 'utf8');
  const content = svg.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<symbol id="i-${id}" viewBox="0 0 24 24">${content}</symbol>`;
}));
const html = await readFile('src/renderer/index.html', 'utf8');
await writeFile('dist/index.html', html.replace(
  '<!-- TABLER_ICONS: generated from the official package at build time -->',
  `<svg class="icon-library" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>${symbols.join('')}</defs></svg>`,
));
await copyFile('src/renderer/styles.css', 'dist/styles.css');
await copyFile('src/main/overlay.html', 'dist/overlay.html');
await copyFile('src/asr/tap-worklet.js','dist/tap-worklet.js');
for (const name of await readdir('node_modules/onnxruntime-web/dist')) {
  if (/^ort-wasm-simd-threaded\.jsep\.(mjs|wasm)$/.test(name)) await copyFile(path.join('node_modules/onnxruntime-web/dist',name),path.join('dist/ort',name));
}
execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/icon.ps1'],{stdio:'inherit',windowsHide:true});
await copyFile('assets/icon.png','dist/icon.png');
if (process.platform === 'win32') execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','native/build.ps1'],{stdio:'inherit',windowsHide:true});
console.log('Voice Scribe built.');
