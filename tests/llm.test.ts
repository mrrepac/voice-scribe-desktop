import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { completionUrl, proofread, listModels } from '../src/main/llm';
import { DEFAULT_SETTINGS } from '../src/shared/contracts';
import { validateSettings } from '../src/main/storage';

const settings = { ...DEFAULT_SETTINGS, llmEnabled: true, llmModel: 'test-model' };
const signal = () => new AbortController().signal;
const reply = (data: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(data), { status });
test('endpoint permits HTTPS and loopback HTTP, rejects embedded credentials and remote HTTP', () => {
  assert.equal(completionUrl('https://example.com/v1/'), 'https://example.com/v1/chat/completions');
  assert.equal(completionUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1/chat/completions');
  for (const value of ['http://example.com/v1', 'https://key@example.com/v1', 'https://example.com?key=secret', 'file:///x', '']) assert.throws(() => completionUrl(value));
});
test('proofreading sends only supplied text with protected instructions and accepts a complete answer', async () => {
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string,string>).Authorization, 'Bearer secret');
    const body = JSON.parse(String(options?.body));
    assert.equal(body.model, 'test-model');
    assert.equal(body.messages[1].content, 'превет мир');
    assert.equal(body.messages.length, 2);
    assert.equal(body.stream, false);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Привет, мир!' } }] }));
  };
  assert.deepEqual(await proofread('превет мир', settings, 'secret', signal(), request), {text:'Привет, мир!',issues:[],reviewed:false});
});
test('disabled API, missing model and invalid input never send a request', async () => {
  const request: typeof fetch = async () => { assert.fail('Unexpected request'); };
  for (const [text, config] of [['text', DEFAULT_SETTINGS], ['text', {...settings,llmModel:''}], ['', settings], ['x'.repeat(50001), settings]] as const)
    await assert.rejects(proofread(text, config, '', signal(), request));
});
test('refusals, truncated output, malformed and empty responses are not used as replacement text', async () => {
  for (const choice of [{finish_reason:'length',message:{content:'часть'}}, {finish_reason:'stop',message:{content:''}}, {finish_reason:'stop',message:{refusal:'no'}}, {message:{content:'text'}}])
    await assert.rejects(proofread('text', settings, '', signal(), reply({choices:[choice]})));
  await assert.rejects(proofread('text',settings,'',signal(),async()=>new Response('<html>')));
});
test('errors redact provider response bodies and explain authentication and quota failures', async () => {
  await assert.rejects(proofread('text',settings,'secret',signal(),reply({error:'secret'},401)), /HTTP 401.*api.openai.com.*ключ/);
  await assert.rejects(proofread('text',settings,'secret',signal(),reply({error:'secret'},429)), /HTTP 429.*Лимит/);
});
test('cancellation aborts the request', async () => {
  const controller = new AbortController();
  const request: typeof fetch = async (_url, options) => {
    controller.abort();
    options?.signal?.throwIfAborted();
    throw new Error('unreachable');
  };
  await assert.rejects(proofread('text', settings, '', controller.signal, request), /отменена/);
});
test('settings stay opt-in and never persist an API key', () => {
  assert.equal(validateSettings({}).llmEnabled, false);
  const validated = validateSettings({...settings,llmBaseUrl:' http://localhost:1234/v1 ',llmModel:' model ',apiKey:'secret'});
  assert.equal(validated.llmModel,'model');
  assert.equal(validated.llmBaseUrl,'http://localhost:1234/v1');
  assert.equal('apiKey' in validated,false);
});

test('provider endpoints normalize full methods and missing schemes', () => {
  assert.equal(completionUrl('ask.chadgpt.ru/api/v1/chat/completions/'),'https://ask.chadgpt.ru/api/v1/chat/completions');
  assert.equal(completionUrl('localhost:1234/v1/models'),'http://localhost:1234/v1/chat/completions');
});
test('provider model lists use matching authentication and never send text', async () => {
  for (const [base,auth] of [['https://gptunnel.ru/v1','secret'],['https://ask.chadgpt.ru/api/v1','Bearer secret'],['https://api.polza.ai/api/v1','Bearer secret']]) {
    const request: typeof fetch = async (url,options) => {
      assert.equal(url,base+'/models');
      assert.equal(options?.method,'GET');
      assert.equal(options?.body,undefined);
      assert.equal((options?.headers as Record<string,string>).Authorization,auth);
      return new Response(JSON.stringify({data:[{id:'z'},{id:'a'},{id:'z'},{}]}));
    };
    assert.deepEqual(await listModels(base,'secret',signal(),request),['a','z']);
  }
});
test('model catalogue errors are explicit', async () => {
  await assert.rejects(listModels(settings.llmBaseUrl,'',signal(),reply({},401)),/401/);
  await assert.rejects(listModels(settings.llmBaseUrl,'',signal(),reply({data:[]})),/пуст/);
  await assert.rejects(listModels(settings.llmBaseUrl,'',signal(),reply({})),/вручную/);
});

test('external proofreading uses contextual plain text and never creates review annotations',async()=>{
  const request: typeof fetch=async(_url,options)=>{
    const body=JSON.parse(String(options?.body));
    assert.match(body.messages[0].content,/по контексту/);
    assert.match(body.messages[0].content,/без JSON/);
    assert.doesNotMatch(body.messages[0].content,/"issues"/);
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Готовый текст.'}}]}));
  };
  assert.deepEqual(await proofread('готовый текст',settings,'key',signal(),request,'plain'),{text:'Готовый текст.',issues:[],reviewed:false});
});
test('internal proofreading requests structured uncertainty review',async()=>{
  const request: typeof fetch=async(_url,options)=>{
    const body=JSON.parse(String(options?.body));
    assert.match(body.messages[0].content,/Не угадывай/);
    const content=JSON.stringify({text:'Имя.',issues:[{quote:'Имя',reason:'Нужен контекст.'}]});
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));
  };
  assert.equal((await proofread('Имя.',settings,'key',signal(),request,'review')).issues.length,1);
});
