import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { makeProofreadBatches, parseBatchResult, validateBatch } from '../src/shared/proofread-batch';
import { proofreadBatch } from '../src/main/llm';
import { DEFAULT_SETTINGS } from '../src/shared/contracts';

test('batch boundaries include neighboring original phrases without duplicating target ids',()=>{
  const batches=makeProofreadBatches(Array.from({length:50},(_,i)=>({text:`phrase ${i}`})));
  assert.equal(batches.length,3);
  assert.deepEqual(batches[1].context.map(cue=>cue.id),[22,23,48,49]);
  assert.deepEqual(batches.flatMap(batch=>validateBatch(batch).cues.map(cue=>cue.id)),Array.from({length:50},(_,i)=>i));
});
test('missing, duplicate, extra or empty returned cues cannot replace subtitles',()=>{
  const batch={cues:[{id:2,text:'first'},{id:3,text:'second'}],context:[]};
  const a={id:2,text:'First.',issues:[]},b={id:3,text:'Second.',issues:[]};
  assert.deepEqual(parseBatchResult(JSON.stringify({cues:[b,a]}),batch).map(cue=>cue.id),[2,3]);
  for(const cues of [[a],[a,a],[a,b,{id:4,text:'extra',issues:[]}],[a,{...b,text:''}]])assert.throws(()=>parseBatchResult(JSON.stringify({cues}),batch));
});
test('batch sends context and validates a complete response before accepting it',async()=>{
  const batch={cues:[{id:0,text:'hello'}],context:[{id:1,text:'world'}]};
  const settings={...DEFAULT_SETTINGS,llmEnabled:true,llmModel:'test'};
  const request:typeof fetch=async(_url,options)=>{
    const body=JSON.parse(String(options?.body));
    assert.deepEqual(JSON.parse(body.messages[1].content),batch);
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({cues:[{id:0,text:'Hello.',issues:[]}]})}}]}));
  };
  const result=await proofreadBatch(batch,settings,'',new AbortController().signal,request);
  assert.equal(result[0].text,'Hello.');
  await assert.rejects(proofreadBatch({...batch,cues:[]},settings,'',new AbortController().signal,request));
});
