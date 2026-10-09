// Smoke tests of the real app. Bundled separately (dist/smoke-main.cjs) and loaded
// only with --smoke-test, so ordinary starts never load this code.
import { app, BrowserWindow, nativeTheme } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Status } from '../shared/contracts';
import type { NativeBridge } from './native';
import { speakerSmokeTest } from './speaker-smoke';
import { importSmokeTest } from './import-smoke';
import { subtitleSmokeTest } from './subtitle-smoke';
import { correctionSmokeTest } from './correction-smoke';
import { llmSmokeTest } from './llm-smoke';
import { historySmokeTest } from './history-smoke';
import { clipboardSmokeTest } from './clipboard-smoke';
import { gigaamSmokeTest } from './gigaam-smoke';
import { dictationSmokeTest, profileSmokeTest } from './dictation-smoke';
import { playbackSmokeTest } from './playback-smoke';

export interface SmokeContext {
  win: BrowserWindow;
  overlay: BrowserWindow;
  bridge: NativeBridge;
  status(): Status;
  windowId(window: BrowserWindow): string;
}
let win: BrowserWindow;
let overlay: BrowserWindow;
let bridge: NativeBridge;
let status: () => Status;
let windowId: (window: BrowserWindow) => string;

// Optional visual audit of the real renderer. Fixtures below change DOM presentation
// only; they deliberately do not claim to test recording, downloads, or delivery.
async function designSmokeTest():Promise<void> {
  const out=path.join(process.cwd(),'artifacts','design');
  await mkdir(out,{recursive:true});
  const originalTheme=nativeTheme.themeSource;
  const originalBounds=win.getBounds();
  const attachedDebugger=!win.webContents.debugger.isAttached();
  if(attachedDebugger)win.webContents.debugger.attach('1.3');
  const captures:unknown[]=[];
  const failures:string[]=[];
  let expectedView='';
  const settle=()=>new Promise(resolve=>setTimeout(resolve,180));
  const navigate=async(view:string)=>{
    expectedView=view;
    await win.webContents.executeJavaScript(`document.querySelector('[data-view="${view}"]').click(); document.querySelector('main').scrollTop=0; document.querySelector('.view:not([hidden])').scrollTop=0; window.scrollTo(0,0);`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:350,y:20});
    await settle();
  };
  const capture=async(name:string,kind='live',requiredVisible:string[]=[])=>{
    const geometry=await win.webContents.executeJavaScript(`(()=>{
      const visible=el=>el.getClientRects().length && getComputedStyle(el).visibility!=='hidden';
      const name=el=>el.id?'#'+el.id:el.tagName.toLowerCase()+'.'+String(el.className||'').replace(/\\s+/g,'.');
      const bounds=el=>{const r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};};
      const horizontalOverflow=[...document.body.querySelectorAll('*')].filter(el=>visible(el) && el.getBoundingClientRect().width>0).filter(el=>{const r=el.getBoundingClientRect();return r.left < -2 || r.right > innerWidth+2;}).map(el=>({element:name(el),...bounds(el)}));
      const scrollOverflow=[document.documentElement,document.querySelector('main'),...document.querySelectorAll('.view:not([hidden]),.settings-group,.field,.history-item,.file-row,.setup-card')].filter(el=>visible(el) && el.clientWidth>0 && el.scrollWidth>el.clientWidth+2).map(el=>({element:name(el),clientWidth:el.clientWidth,scrollWidth:el.scrollWidth}));
      const requiredVisible=${JSON.stringify(requiredVisible)}.map(selector=>{const el=document.querySelector(selector);if(!el)return {selector,visible:false,missing:true};const r=el.getBoundingClientRect();return {selector,visible:Boolean(visible(el) && r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth),disabled:Boolean(el.disabled),...bounds(el)};});
      return {viewport:{width:innerWidth,height:innerHeight},dark:matchMedia('(prefers-color-scheme: dark)').matches,activeView:document.querySelector('[data-view][aria-current="page"]')?.dataset.view,visibleViews:[...document.querySelectorAll('.view:not([hidden])')].map(el=>el.id),horizontalOverflow,scrollOverflow,requiredVisible};
    })()`);
    // The first capture wakes a hidden window's compositor; wait for its new
    // frame before saving so a preceding view cannot leak into this screenshot.
    await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await settle();
    await writeFile(path.join(out,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    captures.push({name,kind,window:win.getSize(),...geometry});
    if(geometry.activeView!==expectedView || geometry.visibleViews.length!==1 || geometry.visibleViews[0]!=='view-'+expectedView)failures.push(name+': unexpected active view');
    if(geometry.horizontalOverflow.length || geometry.scrollOverflow.length)failures.push(name+': horizontal overflow');
    if(geometry.requiredVisible.some((item:{visible:boolean;disabled:boolean})=>!item.visible || item.disabled))failures.push(name+': primary action is unavailable or outside the viewport');
  };
  try {
    // A hidden smoke window has no native focus. Emulate focus only for this
    // audit so keyboard focus styles can be checked without raising the window.
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    for(const theme of ['light','dark'] as const){
      nativeTheme.themeSource=theme;
      for(const size of [{name:'default',width:760,height:620},{name:'minimum',width:600,height:480}]){
        win.setSize(size.width,size.height);
        await settle();
        for(const view of ['dictation','history','settings']){
          await navigate(view);
          await capture(`${theme}-${size.name}-${view}`,'live',view==='dictation'?['#record-button','#prepare-button','#pick-file']:[]);
          if(view==='settings'){
            const groupCount=await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-group').length`);
            for(let index=1;index<groupCount;index++){
              await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-group')[${index}].scrollIntoView({block:'start',behavior:'instant'})`);
              await settle();
              await capture(`${theme}-${size.name}-settings-section-${index+1}`);
            }
          }
        }
      }
      overlay.webContents.send('status',status());
      await overlay.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      await settle();
      await writeFile(path.join(out,`${theme}-overlay-idle.png`),(await overlay.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      captures.push({name:`${theme}-overlay-idle`,kind:'live-overlay',window:overlay.getSize(),phase:status().phase,note:'The idle overlay is normally hidden; captured here to inspect its theme.'});
      win.setSize(760,620);
      await navigate('settings');
      for(const [label,selector] of [['select','select[name="model"]'],['toggle','input[name="live"]'],['textarea','textarea[name="replacements"]']]){
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        const focus=await win.webContents.executeJavaScript(`(()=>{
          const control=document.querySelector(${JSON.stringify(selector)});
          const surface=control.closest('.switch')?.querySelector('span') || control;
          control.blur();
          const baseline=getComputedStyle(surface);const previous={outline:baseline.outline,boxShadow:baseline.boxShadow};
          control.scrollIntoView({block:'center',behavior:'instant'});control.focus({preventScroll:true});
          const style=getComputedStyle(surface);
          return {selector:${JSON.stringify(selector)},active:document.activeElement===control,focusVisible:control.matches(':focus-visible'),outline:style.outline,boxShadow:style.boxShadow,visibleIndicator:(style.outlineStyle!=='none' && parseFloat(style.outlineWidth)>0 && style.outline!==previous.outline) || (style.boxShadow!=='none' && style.boxShadow!==previous.boxShadow)};
        })()`);
        await settle();
        await capture(`${theme}-focus-${label}`);
        captures.push({name:`${theme}-focus-${label}`,kind:'focus-check',...focus});
        if(!focus.active || !focus.focusVisible || !focus.visibleIndicator)failures.push(`${theme}-focus-${label}: missing visible keyboard focus`);
        await win.webContents.executeJavaScript(`document.activeElement.blur()`);
      }
      await navigate('dictation');
      const editor=await win.webContents.executeJavaScript(`(()=>{
        const field=document.getElementById('result-text');
        const card=document.getElementById('result-card');
        const copy=document.getElementById('copy-result');
        const save=document.getElementById('export-result');
        const value=field.value;
        const visible=card.getClientRects().length>0 && field.getClientRects().length>0;
        const initial={empty:field.value==='',disabled:copy.disabled && save.disabled};
        field.value='Проверка редактирования';field.dispatchEvent(new Event('input',{bubbles:true}));
        const populated={enabled:!copy.disabled && !save.disabled};
        field.value='';field.dispatchEvent(new Event('input',{bubbles:true}));
        const cleared={disabled:copy.disabled && save.disabled};
        field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));
        return {visible,initial,populated,cleared};
      })()`);
      captures.push({name:`${theme}-editor-actions`,kind:'input-check',...editor});
      if(!editor.visible || !editor.initial.empty || !editor.initial.disabled || !editor.populated.enabled || !editor.cleared.disabled)failures.push(`${theme}-editor-actions: editor visibility or action state is incorrect`);
      for(const fixture of ['recording','preparing','error','result']){
        await win.webContents.executeJavaScript(`(()=>{
          const ids=['record-card','status-label','timer','record-title','record-description','record-button','record-button-label','record-icon','cancel-button','setup-card','result-card','result-text','result-label','word-count','result-note','copy-result','export-result','pick-file','prepare-button'];
          const textIds=['status-label','timer','record-title','record-description','record-button-label','result-label','word-count','result-note'];
          const elements=ids.map(id=>document.getElementById(id));
          const snapshot=elements.map(el=>({el,attributes:[...el.attributes].map(a=>[a.name,a.value]),text:textIds.includes(el.id)?el.textContent:null,value:el.id==='result-text'?el.value:null}));
          const icon=document.querySelector('#record-icon use');const iconHref=icon.getAttribute('href');
          const bars=[...document.querySelectorAll('#waveform i')].map(el=>({el,style:el.style.cssText}));
          window.__scribeDesignRestore=()=>{for(const saved of snapshot){for(const attribute of [...saved.el.attributes])saved.el.removeAttribute(attribute.name);for(const [name,value] of saved.attributes){if(name==='style')saved.el.style.cssText=value;else saved.el.setAttribute(name,value);}if(saved.text!==null)saved.el.textContent=saved.text;if(saved.value!==null)saved.el.value=saved.value;}icon.setAttribute('href',iconHref);for(const bar of bars)bar.el.style.cssText=bar.style;delete window.__scribeDesignRestore;};
          const set=(id,text)=>document.getElementById(id).textContent=text;
          const fixture=${JSON.stringify(fixture)};
          const busy=['recording','preparing'].includes(fixture);
          document.getElementById('record-card').dataset.phase=fixture==='result'?'idle':fixture;
          document.getElementById('cancel-button').hidden=!busy;
          document.getElementById('record-button').disabled=fixture==='preparing';
          const buttonLabel=fixture==='recording'?'Стоп':fixture==='preparing'?'Подготовка…':fixture==='error'?'Повторить':'Записать';
          set('record-button-label',buttonLabel);document.getElementById('record-button').setAttribute('aria-label',buttonLabel);
          for(const id of ['pick-file','prepare-button'])document.getElementById(id).disabled=busy;
          if(fixture==='recording'){
            set('status-label','Запись');set('timer','00:12');set('record-title','Запись');set('record-description','');
            icon.setAttribute('href','#i-stop');bars.forEach(({el},i)=>el.style.transform='scaleY('+(0.15+Math.abs(Math.sin(i*.71))*.85)+')');
          }else if(fixture==='preparing'){
            set('status-label','Загружаем модель · 42%');set('record-title','Подготовка модели');set('record-description','Загружаем модель · 42%. Аудио остаётся на вашем компьютере.');
          }else if(fixture==='error'){
            set('status-label','Ошибка');set('record-title','Ошибка');set('record-description','Нет доступа к микрофону. Разрешите доступ в Windows → Параметры → Конфиденциальность → Микрофон.');
          }else{
            set('status-label','Готово');document.getElementById('setup-card').hidden=true;document.getElementById('result-card').hidden=false;
            document.getElementById('result-text').value='Обсудили новый проект. К пятнице подготовим первый вариант и соберём обратную связь. Следующий шаг — проверить текст и отправить его команде.';
            set('result-label','Текст');set('word-count',document.getElementById('result-text').value.trim().split(/\\s+/u).length+' слов');set('result-note','Скопировано');
            document.getElementById('copy-result').disabled=false;document.getElementById('export-result').disabled=false;
          }
        })()`);
        try {
          await settle();
          await capture(`${theme}-fixture-${fixture}`,'dom-fixture');
          if(fixture==='result'){
            await win.webContents.executeJavaScript(`document.getElementById('result-card').scrollIntoView({block:'center',behavior:'instant'})`);
            await settle();
            await capture(`${theme}-fixture-result-detail`,'dom-fixture');
          }
        }finally{
          await win.webContents.executeJavaScript(`window.__scribeDesignRestore?.(); document.querySelector('main').scrollTop=0; document.querySelector('.view:not([hidden])').scrollTop=0; window.scrollTo(0,0);`);
        }
      }
    }
  }catch(error){
    failures.push('Visual audit interrupted: '+String(error));
    throw error;
  }finally{
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});
    if(attachedDebugger)win.webContents.debugger.detach();
    nativeTheme.themeSource=originalTheme;
    win.setBounds(originalBounds);
    await writeFile(path.join(out,'design-report.json'),JSON.stringify({ok:failures.length===0,notes:['Live captures use the isolated smoke profile.','DOM fixture captures verify presentation only; audio recording, model download, and text delivery are not exercised.','Viewport dimensions exclude the native window frame.'],failures,captures},null,2));
  }
  if(failures.length)throw new Error('Design smoke failed: '+failures.join('; '));
}
export async function runSmoke(context:SmokeContext):Promise<void> {
  ({win,overlay,bridge,windowId,status}=context);
  const out=path.join(process.cwd(),'artifacts',app.isPackaged?'packaged':'.'); await mkdir(out,{recursive:true});
  const logs:string[]=[];
  win.webContents.on('console-message',({message})=>logs.push(message));
  try {
    await new Promise(resolve=>setTimeout(resolve,1200));
    const result=await win.webContents.executeJavaScript(`(async()=>{ const settings=await window.scribe.getSettings(); const info=await window.scribe.getAppInfo(); if(document.querySelector('#record-button').disabled || document.querySelector('#record-card').dataset.phase==='error')throw new Error('UI boot failed: '+document.body.innerText); return {title:document.title,settings,info,body:document.body.innerText.slice(0,1000)}; })()`);
    await writeFile(path.join(out,'smoke-ui.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('[data-view="settings"]').click()`);
    await new Promise(resolve=>setTimeout(resolve,200));
    await writeFile(path.join(out,'smoke-settings.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('[data-view="history"]').click()`);
    await new Promise(resolve=>setTimeout(resolve,200));
    await writeFile(path.join(out,'smoke-history.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    if(process.argv.includes('--design-test'))await designSmokeTest();
    if(process.argv.includes('--import-test'))await importSmokeTest(win);
    if(process.argv.includes('--speakers-test'))await speakerSmokeTest(win);
    if(process.argv.includes('--subtitles-test'))await subtitleSmokeTest(win);
    if(process.argv.includes('--corrections-test'))await correctionSmokeTest(win);
    if(process.argv.includes('--llm-test'))await llmSmokeTest(win);
    if(process.argv.includes('--history-test'))await historySmokeTest(win);
    const giga=process.argv.includes('--gigaam-test')?await gigaamSmokeTest(win):undefined;
    if(giga)console.log('GIGAAM_SMOKE',JSON.stringify(giga));
    if(process.argv.includes('--playback-test'))console.log('PLAYBACK_SMOKE',JSON.stringify(await playbackSmokeTest(win)));
    if(process.argv.includes('--profile-test')){
      const target=new BrowserWindow({show:false,width:300,height:200});
      try{console.log('PROFILE_SMOKE',JSON.stringify(await profileSmokeTest(win,windowId(target))));}
      finally{target.destroy();}
    }
    if(process.argv.includes('--dictation-test'))console.log('DICTATION_SMOKE',JSON.stringify(await dictationSmokeTest(win)));
    if(!bridge.ready)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Native helper startup timeout')),10000);bridge.once('ready',()=>{clearTimeout(timer);resolve();});bridge.once('failure',message=>{clearTimeout(timer);reject(new Error(message));});});
    if(process.argv.includes('--clipboard-test'))await clipboardSmokeTest(win,bridge);
    const native=await bridge.request('diagnostics');
    const asr=app.isPackaged ? await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const w=new Worker('./asr-worker.js',{type:'module'}); const t=setTimeout(()=>{w.terminate();reject(new Error('Packaged worker timeout'));},20000); w.onerror=e=>{clearTimeout(t);w.terminate();reject(new Error(e.message));}; w.onmessage=({data})=>{if(data.t==='ready')w.postMessage({t:'plan',id:1,pref:'auto',devicePref:'auto'});if(data.t==='plan'){clearTimeout(t);w.terminate();resolve({ok:true,plan:data.plan});}if(data.t==='error'){clearTimeout(t);w.terminate();reject(new Error(data.message));}};})`) : await win.webContents.executeJavaScript(`(async()=>{ const m=await import('./smoke.js'); const audio=${process.argv.includes('--asr-test')} ? await (await fetch('./fixture.wav')).arrayBuffer() : undefined; return m.runAsrSmoke({model:'auto',device:'auto',audio,checkIsolation:true}); })()`);
    if(asr.ok===false)throw new Error(JSON.stringify(asr));
    await writeFile(path.join(out,'smoke-result.json'),JSON.stringify({ok:true,result,native,asr,logs},null,2));
    console.log('SMOKE_OK',JSON.stringify({native,asr}));
  } catch(error) {
    await writeFile(path.join(out,'smoke-result.json'),JSON.stringify({ok:false,error:String(error),logs},null,2)); console.error(error);process.exitCode=1;
  }
}
