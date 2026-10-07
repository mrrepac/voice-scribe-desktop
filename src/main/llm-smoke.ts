import { app, type BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { strict as assert } from 'node:assert';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/contracts';

export async function llmSmokeTest(win: BrowserWindow): Promise<void> {
  const profile = app.getPath('userData');
  assert.equal(path.resolve(profile), path.resolve(process.cwd(), '.data', app.isPackaged ? 'smoke-packaged' : 'smoke'));
  const files = await Promise.all(['settings.json','history.json','api-key.enc'].map(async name => {
    const file = path.join(profile,name);
    const data = await readFile(file).catch(error => { if(error.code === 'ENOENT') return null; throw error; });
    return {file,data};
  }));
  let mode: 'ok' | 'error' | 'slow' = 'ok';
  let requests = 0;
  const server = createServer(async (req,res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests++;
    if(req.url==='/v1/models') {
      assert.equal(req.headers.authorization,'Bearer smoke-test-key');
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({data:[{id:'smoke'},{id:'second-model'}]}));
      return;
    }
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer smoke-test-key');
    const input = JSON.parse(body).messages[1].content;
    const code = mode === 'error' ? 401 : 200;
    const corrected=input.replace('превет','Привет')+'!';
    const batch=JSON.parse(body).messages[0].content.includes('корректор субтитров') ? JSON.parse(input) : null;
    const content=batch ? JSON.stringify({cues:batch.cues.map((cue:any)=>({id:cue.id,text:cue.text.replace('превет','Привет')+'!',issues:[]}))}) : JSON.stringify({text:corrected,issues:corrected.includes('мир')?[{quote:'мир',reason:'Нужен контекст: <b>обращение или название?</b>'}]:[]});
    const send = () => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]})); };
    if (mode === 'slow') setTimeout(send, 1200); else send();
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const address = server.address() as {port:number};
  const execute = (source:string) => win.webContents.executeJavaScript(source);
  const until = async (source:string) => {
    const end = Date.now()+8000;
    while (Date.now()<end) { if(await execute(source)) return; await new Promise(r=>setTimeout(r,50)); }
    throw new Error('Smoke timed out: '+source);
  };
  const text = () => execute(`document.querySelector('#result-text').value`);
  const idle = () => until(`document.querySelector('#record-card').dataset.phase==='idle'`);
  const open = async(id:string) => {
    await execute(`document.querySelector('[data-view="history"]').click();document.querySelector('[data-open-history="${id}"]').click()`);
  };
  try {
    await execute(`window.scribe.saveSettings(${JSON.stringify({...DEFAULT_SETTINGS,llmEnabled:true,llmBaseUrl:`http://127.0.0.1:${address.port}/v1`,llmModel:'smoke'})})`);
    await execute(`window.scribe.saveApiKey('smoke-test-key')`);
    assert.equal(await execute(`window.scribe.hasApiKey()`),true);
    await execute(`(async()=>{const s=await window.scribe.getSettings();await window.scribe.saveSettings({...s,llmBaseUrl:'https://ask.chadgpt.ru/api/v1'});})()`);
    assert.equal(await execute(`window.scribe.hasApiKey()`),false);
    await execute(`(async()=>{const s=await window.scribe.getSettings();await window.scribe.saveSettings({...s,llmBaseUrl:'http://127.0.0.1:${address.port}/v1'});})()`);
    assert.equal(await execute(`window.scribe.hasApiKey()`),true);
    assert.equal((await readFile(path.join(profile,'api-key.enc'))).includes(Buffer.from('smoke-test-key')),false);
    const plain = await execute(`window.scribe.addHistory('превет мир','dictation')`);
    const timed = await execute(`window.scribe.addHistory('превет','file',{segments:[{start:1,end:2,text:'превет',speaker:'Анна'},{start:3,end:4,text:'мир',speaker:'Борис'}]})`);
    await win.loadURL('scribe://app/index.html');
    await until(`!document.querySelector('#record-button').disabled`);
    await open(plain.id);
    const beforeExternalIdle=requests;
    win.webContents.send('command',{action:'proofread',mode:'plain'});
    await new Promise(r=>setTimeout(r,150));
    assert.equal(requests,beforeExternalIdle);
    assert.equal(await text(),'превет мир');
    win.webContents.send('command',{action:'proofread'});
    await until(`document.querySelector('#result-text').value==='Привет мир!'`);
    await idle();
    assert.equal(await execute(`document.querySelector('#proofread-review').hidden`),false);
    assert.match(await execute(`document.querySelector('#proofread-review del').textContent`),/превет/);
    assert.equal(await execute(`document.querySelector('#proofread-review mark').textContent`),'мир');
    assert.equal(await execute(`document.querySelector('#proofread-review b')===null`),true);
    await execute(`document.querySelector('[data-review-select]').click()`);
    assert.equal(await execute(`(()=>{const t=document.querySelector('#result-text');return t.value.slice(t.selectionStart,t.selectionEnd)})()`),'мир');
    await execute(`const t=document.querySelector('#result-text');t.value+=' Правка';t.dispatchEvent(new Event('input',{bubbles:true}))`);
    assert.equal(await execute(`document.querySelector('[data-review-select]').disabled`),true);
    assert.match(await execute(`document.querySelector('#review-state').textContent`),/вручную/);
    await execute(`document.querySelector('#undo-proofread').click()`);
    assert.equal(await text(),'превет мир');
    mode = 'error';
    await execute(`document.querySelector('#proofread-result').click()`);
    await idle();
    assert.equal(await text(),'превет мир');
    assert.match(await execute(`document.querySelector('#toast').textContent`),/401/);
    mode = 'slow';
    const prior = requests;
    await execute(`document.querySelector('#proofread-result').click()`);
    while(requests === prior) await new Promise(r=>setTimeout(r,20));
    win.webContents.send('command',{action:'cancel'});
    await idle();
    await new Promise(r=>setTimeout(r,1300));
    assert.equal(await text(),'превет мир');
    mode = 'ok';
    await open(timed.id);
    await execute(`document.querySelector('#proofread-result').click()`);
    await until(`document.querySelector('#result-text').value.includes('Привет!')`);
    await idle();
    await until(`document.querySelector('#transcript-save').textContent==='Правки сохранены'`);
    const saved = (await execute(`window.scribe.getHistory()`)).find((item:any)=>item.id===timed.id);
    assert.deepEqual(saved.segments,[{start:1,end:2,text:'Привет!',speaker:'Анна'},{start:3,end:4,text:'мир!',speaker:'Борис'}]);
    const out = path.resolve('artifacts','llm');
    await mkdir(out,{recursive:true});
    await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await new Promise(r=>setTimeout(r,200));
    await writeFile(path.join(out,'editor.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await execute(`document.querySelector('[data-view="settings"]').click();document.querySelector('[name="llmBaseUrl"]').closest('.settings-group').scrollIntoView({block:'start'})`);
    await execute(`document.querySelector('#llm-fetch-models').click()`);
    await until(`document.querySelector('#llm-model-list').options.length===3`);
    await idle();
    await execute(`const s=document.querySelector('#llm-model-list');s.value='smoke';s.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#llm-test').click()`);
    await until(`document.querySelector('#llm-connection-status').textContent.includes('Подключение работает')`);
    await idle();
    await new Promise(r=>setTimeout(r,150));
    await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await new Promise(r=>setTimeout(r,200));
    await writeFile(path.join(out,'settings.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await execute(`window.scribe.saveApiKey('')`);
    assert.equal(await execute(`window.scribe.hasApiKey()`),false);
    await execute(`const p=document.querySelector('#llm-provider');p.value='chadgpt';p.dispatchEvent(new Event('change',{bubbles:true}))`);
    await until(`document.querySelector('#llm-key-status').textContent.includes('не сохранён')`);
    assert.equal(await execute(`document.querySelector('[name="llmBaseUrl"]').value`),'https://ask.chadgpt.ru/api/v1');
    await writeFile(path.join(out,'result.json'),JSON.stringify({ok:true,requests,checks:['encrypted key','provider key isolation','provider preset selection','model catalogue UI','connection test UI','hotkey proofreading','actual text diff','uncertainty highlighting','select issue in editor','stale report after edits','model markup is not HTML','undo','HTTP failure preserves text','cancel discards late response','timestamps and speakers preserved','delete key']},null,2));
  } finally {
    server.closeAllConnections();
    server.close();
    for (const {file,data} of files) { if(data===null) await rm(file,{force:true}); else await writeFile(file,data); }
  }
}
