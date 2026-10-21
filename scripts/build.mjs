import { build } from 'esbuild';
import { mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Electron 44 does not download its runtime during npm install. This official
// installer is idempotent and verifies the runtime matches the package version.
execFileSync(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit', windowsHide: true });
// A fresh dist: files left by older builds would otherwise end up in the installer.
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({entryPoints:['src/main/index.ts'],outfile:'dist/main.cjs',platform:'node',format:'cjs',bundle:true,external:['electron','electron-updater'],target:'node22'});
// Smoke tests are loaded only with --smoke-test from a source checkout; installers leave them out.
await build({entryPoints:['src/main/smoke.ts'],outfile:'dist/smoke-main.cjs',platform:'node',format:'cjs',bundle:true,external:['electron','electron-updater'],target:'node22'});
await build({entryPoints:['src/main/gigaam-worker.ts'],outfile:'dist/gigaam-worker.cjs',platform:'node',format:'cjs',bundle:true,external:['sherpa-onnx-node'],target:'node22'});
await build({entryPoints:['src/main/preload.ts'],outfile:'dist/preload.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node22'});
await build({entryPoints:['src/main/overlay-preload.ts'],outfile:'dist/overlay-preload.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node22'});
await build({entryPoints:['src/renderer/index.ts'],outfile:'dist/renderer.js',platform:'browser',format:'esm',bundle:true,target:'chrome130'});
if(process.argv.includes('--smoke') && existsSync('artifacts/fixture-ru.wav'))await copyFile('artifacts/fixture-ru.wav','dist/fixture-ru.wav');
// Inline only the icons the app uses. No network or icon font is needed at runtime.
const iconNames = {
  mic: 'microphone', copy: 'copy', download: 'download', stop: 'player-stop',
  'chevron-down': 'chevron-down', tray: 'arrow-down-right', file: 'file-upload', save: 'device-floppy',
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
// The icons are committed; Windows regenerates them from scripts/icon.ps1.
if (process.platform === 'win32') execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/icon.ps1'],{stdio:'inherit',windowsHide:true});
await copyFile('assets/icon.png','dist/icon.png');
await copyFile('assets/trayTemplate.png','dist/trayTemplate.png');
await copyFile('assets/trayTemplate@2x.png','dist/trayTemplate@2x.png');
if (process.platform === 'win32') execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','native/build.ps1'],{stdio:'inherit',windowsHide:true});
if (process.platform === 'darwin') execFileSync('sh',['native/mac/build.sh'],{stdio:'inherit'});
console.log('Voice Scribe built.');
