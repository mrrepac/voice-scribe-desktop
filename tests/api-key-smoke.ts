import { app, safeStorage } from 'electron';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ApiKeyStore } from '../src/main/api-key';

void app.whenReady().then(async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'scribe-key-test-'));
  try {
    const store=new ApiKeyStore(root);
    const a='https://first.example/v1';
    const b='https://second.example/v1';
    await writeFile(path.join(root,'api-key.enc'),safeStorage.encryptString('legacy-fixture'));
    await store.migrate(a);
    assert.equal(await store.get(a),'legacy-fixture');
    assert.equal(await store.get(b),'');
    await store.save('second-fixture',b);
    assert.equal(await store.get(a),'legacy-fixture');
    assert.equal(await store.get(b+'/chat/completions'),'second-fixture');
    await store.save('',b);
    assert.equal(await store.get(b),'');
    assert.equal(await store.get(a),'legacy-fixture');
    assert.equal((await readFile(path.join(root,'api-key.enc'))).includes(Buffer.from('legacy-fixture')),false);
    console.log('KEY_SMOKE_OK: legacy migration, endpoint isolation, independent deletion, encrypted storage');
  } finally { await rm(root,{recursive:true,force:true}); }
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
