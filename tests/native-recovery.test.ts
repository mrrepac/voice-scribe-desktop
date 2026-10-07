import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { NativeRecovery } from '../src/main/native-recovery';
class Fake extends EventEmitter { starts=0; start(){this.starts++;} stop(){} }
test('recovery limits repeated failures and manual retry resets budget; shutdown cancels retries',async()=>{
  const bridge=new Fake();const recovery=new NativeRecovery(bridge,'helper',()=>{},[1,1],1000);
  try {
    recovery.restart();assert.equal(bridge.starts,1);
    bridge.emit('failure');await new Promise(resolve=>setTimeout(resolve,10));
    bridge.emit('ready');bridge.emit('failure');await new Promise(resolve=>setTimeout(resolve,10));
    bridge.emit('failure');await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(bridge.starts,3);assert.equal(recovery.state.retrying,false);assert.equal(recovery.state.ready,false);
    recovery.restart();assert.equal(bridge.starts,4);
    bridge.emit('failure');recovery.stop();await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(bridge.starts,4);
  }finally{recovery.stop();}
});
