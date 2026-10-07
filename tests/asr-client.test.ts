import test from 'node:test';
import assert from 'node:assert/strict';
import { AsrClient } from '../src/asr/client';
import { Recorder } from '../src/asr/recorder';
import { runAsrSmoke } from '../src/asr/smoke';
import type { FromWorker, ToWorker } from '../src/asr/protocol';

const bridge = { cacheGet: async () => null, cachePut: async () => {} };
const speech = () => Float32Array.from({length: 16000}, (_, i) => Math.sin(i / 12) * 0.2);

class FakeWorker {
  static instances: FakeWorker[] = [];
  static holdLoad = false;
  static holdRun = false;
  onmessage: ((event: {data: FromWorker}) => void) | null = null;
  onerror: unknown;
  onmessageerror: unknown;
  terminated = false;
  messages: ToWorker[] = [];
  loaded = '';
  constructor() {
    FakeWorker.instances.push(this);
    queueMicrotask(() => this.emit({t: 'ready'}));
  }
  emit(data: FromWorker): void { this.onmessage?.({data}); }
  terminate(): void { this.terminated = true; }
  postMessage(message: ToWorker): void {
    this.messages.push(message);
    if (message.t === 'plan') {
      queueMicrotask(() => this.emit({t:'plan',id:message.id,plan:{model:'tiny',modelId:'onnx-community/whisper-tiny',files:['onnx/encoder_model_quantized.onnx','onnx/decoder_model_merged_quantized.onnx']}}));
    } else if (message.t === 'load') {
      this.loaded = message.pref;
      if (!FakeWorker.holdLoad) queueMicrotask(() => this.emit({t:'loaded',id:message.id,info:{model:'base',device:'wasm',f16:false,fellBack:false}}));
    } else if (message.t === 'run') {
      if (!FakeWorker.holdRun) queueMicrotask(() => this.emit({t:'text',id:message.id,text:this.loaded}));
    } else if (message.t === 'run-timed') {
      if (!FakeWorker.holdRun) queueMicrotask(() => this.emit({t:'transcript',id:message.id,transcript:{text:this.loaded,segments:[{start:2,end:3,text:this.loaded}]}}));
    }
  }
}

function install(t: test.TestContext): void {
  FakeWorker.instances = [];
  FakeWorker.holdLoad = false;
  FakeWorker.holdRun = false;
  const descriptors = ['Worker', 'window', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  Object.defineProperty(globalThis, 'Worker', {configurable:true,value:FakeWorker});
  Object.defineProperty(globalThis, 'window', {configurable:true,value:{location:{href:'https://scribe.local/index.html'}}});
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor);
      else Reflect.deleteProperty(globalThis,key);
    }
  });
}

test('silence returns without opening a worker or loading a model', async t => {
  install(t);
  const client = new AsrClient(bridge);
  assert.equal(await client.transcribe(new Float32Array(16000), {model:'tiny',device:'wasm',language:'ru'}),'');
  assert.equal(FakeWorker.instances.length,0);
  client.destroy();
});

test('concurrent transcriptions keep their own model load and input buffers', async t => {
  install(t);
  const client = new AsrClient(bridge);
  const pcm = speech();
  const results = await Promise.all([
    client.transcribe(pcm,{model:'tiny',device:'wasm',language:'ru'}),
    client.transcribe(pcm,{model:'base',device:'wasm',language:'en'}),
  ]);
  assert.deepEqual(results,['tiny','base']);
  assert.equal(pcm.length,16000);
  const runs = FakeWorker.instances[0].messages.filter(message => message.t === 'run');
  assert.notEqual(runs[0].pcm,pcm);
  assert.equal(runs[0].language,'ru');
  assert.equal(runs[1].language,'en');
  client.destroy();
});

test('timed silence returns an empty transcript without starting a worker', async t => {
  install(t);
  const client = new AsrClient(bridge);
  assert.deepEqual(await client.transcribeTimed(new Float32Array(16000), {model:'tiny',device:'wasm',language:'ru'}), {text:'',segments:[]});
  assert.equal(FakeWorker.instances.length, 0);
  client.destroy();
});

test('timed requests propagate worker cues and preserve source PCM for retry', async t => {
  install(t);
  const client = new AsrClient(bridge);
  const pcm = speech();
  const result = await client.transcribeTimed(pcm, {model:'tiny',device:'wasm',language:'ru',language2:'en'});
  assert.deepEqual(result, {text:'tiny',segments:[{start:2,end:3,text:'tiny'}]});
  const request = FakeWorker.instances[0].messages.find(message => message.t === 'run-timed');
  assert.ok(request);
  assert.notEqual(request.pcm, pcm);
  assert.equal(request.language, 'ru');
  assert.equal(request.language2, 'en');
  assert.deepEqual(request.pcm, pcm);
  client.destroy();
});

test('cancel terminates timed inference and ignores late transcript messages', async t => {
  install(t);
  FakeWorker.holdRun = true;
  const client = new AsrClient(bridge);
  const transcription = client.transcribeTimed(speech(), {model:'tiny',device:'wasm',language:'ru'});
  const rejected = assert.rejects(transcription, {name:'AbortError'});
  await new Promise(resolve => setTimeout(resolve,0));
  const worker = FakeWorker.instances[0];
  const request = worker.messages.find(message => message.t === 'run-timed');
  assert.ok(request);
  client.cancel();
  worker.emit({t:'transcript',id:request.id,transcript:{text:'late',segments:[{start:0,end:1,text:'late'}]}});
  await rejected;
  assert.equal(worker.terminated, true);
  FakeWorker.holdRun = false;
  assert.equal(await client.transcribe(speech(), {model:'base',device:'wasm',language:'ru'}), 'base');
  client.destroy();
});

test('cancel terminates loading and rejects queued requests; later prepare recovers', async t => {
  install(t);
  FakeWorker.holdLoad = true;
  const client = new AsrClient(bridge);
  const first = client.prepare({model:'base',device:'wasm'});
  const second = client.prepare({model:'tiny',device:'wasm'});
  const results = Promise.allSettled([first,second]);
  await new Promise(resolve => setTimeout(resolve,0));
  client.cancel();
  for (const result of await results) {
    assert.equal(result.status,'rejected');
    if (result.status === 'rejected') assert.equal(result.reason.name,'AbortError');
  }
  assert.equal(FakeWorker.instances[0].terminated,true);
  FakeWorker.holdLoad = false;
  await client.prepare({model:'tiny',device:'wasm'});
  assert.equal(FakeWorker.instances.length,2);
  client.destroy();
});

test('worker failure releases pending requests', async t => {
  install(t);
  FakeWorker.holdLoad = true;
  const client = new AsrClient(bridge);
  const loading = client.prepare({model:'base',device:'wasm'});
  const result = assert.rejects(loading,/GPU process stopped/);
  await new Promise(resolve => setTimeout(resolve,0));
  const worker = FakeWorker.instances[0];
  (worker.onerror as (event:{message:string}) => void)({message:'GPU process stopped'});
  await result;
  assert.equal(worker.terminated,true);
  client.destroy();
});

test('cancel while microphone permission is pending stops the late stream', async t => {
  install(t);
  let grant!: (stream: MediaStream) => void;
  let stopped = 0;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:() => new Promise<MediaStream>(resolve => {grant=resolve;})}}});
  const recorder = new Recorder();
  const starting = recorder.start();
  const rejected = assert.rejects(starting,{name:'AbortError'});
  recorder.cancel();
  grant({getTracks:() => [{stop:() => stopped++}]} as unknown as MediaStream);
  await rejected;
  assert.equal(stopped,1);
  assert.equal(recorder.state,'idle');
});

test('offline smoke reports missing cache without starting model inference', async t => {
  install(t);
  Object.defineProperty(window,'scribe',{configurable:true,value:{...bridge,cacheHas:async () => false}});
  const result = await runAsrSmoke({model:'tiny',device:'wasm',prepare:true});
  assert.equal(result.ok,false);
  assert.equal(result.stage,'cache');
  assert.equal(result.cacheCheck,'missing');
  assert.ok(result.missingFiles.includes('onnx/encoder_model_quantized.onnx'));
  assert.equal(FakeWorker.instances[0].messages.some(message => message.t === 'load'),false);
  assert.equal(FakeWorker.instances[0].terminated,true);
});

test('plan-only smoke boots the worker and finishes without requiring cached models', async t => {
  install(t);
  Object.defineProperty(window,'scribe',{configurable:true,value:bridge});
  const result = await runAsrSmoke({model:'tiny',device:'wasm'});
  assert.equal(result.ok,true);
  assert.equal(result.stage,'done');
  assert.equal(result.cacheCheck,'not-needed');
  assert.equal(FakeWorker.instances[0].messages.some(message => message.t === 'load'),false);
  assert.equal(FakeWorker.instances[0].terminated,true);
});
