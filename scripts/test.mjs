import { build } from 'esbuild';
import { readdir, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await mkdir('.test-build',{recursive:true});
const files=(await readdir('tests')).filter(name=>name.endsWith('.test.ts'));
for(const file of files) await build({entryPoints:[`tests/${file}`],outfile:`.test-build/${file.replace(/\.ts$/,'.mjs')}`,platform:'node',format:'esm',bundle:true,target:'node22',packages:'external'});
execFileSync(process.execPath,['--test',...files.map(file=>`.test-build/${file.replace(/\.ts$/,'.mjs')}`)],{stdio:'inherit'});
if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','native/build.ps1','-Test'],{stdio:'inherit',windowsHide:true});
