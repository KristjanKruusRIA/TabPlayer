import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {installBackingProcessingObserver,observeTauriFallback,assertNoTauriFallback} from './parity-backing-processing.mjs';

// Deliberately no app, IPC, filesystem writes or network: the serialized installer sees a fake window.
function fixture({header='ok',mixHeader=header,mixResult=null,cloneError=false,fetchWritable=true,fallback=false,fallbackCommand=null,warn=()=>{}}={}){
  const calls=[],responses=[],status={ready:true,generation:7,playing:false};
  let fellBack=false;
  const window={},api={convertFileSrc:(command,protocol)=>`http://${protocol}.localhost/${command}`};
  const transport=async(...request)=>{
    calls.push(request);const command=request[0].split('/').at(-1),result=command==='audio_status'?status:mixHeader==='error'?'native failure':mixResult,responseHeader=command==='audio_status'?header:mixHeader;
    const response=new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json',...(responseHeader===null?{}:{'Tauri-Response':responseHeader})}});
    if(cloneError&&command!=='audio_status')response.clone=()=>{throw Error('clone diagnostic failure');};
    if(command===fallbackCommand)throw Error('fake custom-protocol failure');
    responses.push(response);return response;
  };
  Object.defineProperty(window,'fetch',{value:transport,writable:fetchWritable});
  Object.defineProperty(api,'invoke',{value:async(command,args={})=>{
    if(fallback||fellBack)return status;
    let response;try{response=await window.fetch(api.convertFileSrc(command,'ipc'),{method:'POST',body:JSON.stringify(args),headers:{'Content-Type':'application/json','Tauri-Invoke-Key':'never-copy-this-header'}});}catch(error){if(command!==fallbackCommand)throw error;warn('IPC custom protocol failed, Tauri will now use the postMessage interface instead private-error-detail');fellBack=true;return status;}
    const value=await response.json();if(response.headers.get('Tauri-Response')!=='ok')throw Error(String(value));return value;
  }});
  Object.defineProperty(window,'__TAURI_INTERNALS__',{value:api});
  const context=vm.createContext({window});
  return {window,api,calls,responses,status,transport,install:()=>vm.runInContext(`(${installBackingProcessingObserver.toString()})()`,context)};
}

async function lateFallbackCase(guard=assertNoTauriFallback){
  const signals=[],page=new EventEmitter(),f=fixture({fallbackCommand:'unobserved_command',warn:text=>page.emit('console',{type:()=> 'warning',text:()=>text})});observeTauriFallback(page,signals,'last-phase');await f.install();await f.api.invoke('audio_set_mix',{generation:7});assert.equal(f.window.__processingEvidence.mix.at(-1).nativeAcknowledged,true);
  // An unobserved command switches transports after the final acknowledged mix.
  assert.deepEqual(await f.api.invoke('unobserved_command'),f.status);const afterFallback=f.calls.length;await f.api.invoke('audio_status');assert.equal(f.calls.length,afterFallback,'Fallback now bypasses fetch despite successful invoke');
  let nextEdit=false;assert.throws(()=>{guard(signals);nextEdit=true;},/Unsupported Tauri postMessage fallback/);assert.equal(nextEdit,false);
  let status='running';assert.throws(()=>{guard(signals);status='passed';},/Unsupported Tauri postMessage fallback/);assert.notEqual(status,'passed');
  assert.deepEqual(signals,[{phase:'last-phase',kind:'tauri-ipc-postmessage-fallback'}]);assert.ok(!JSON.stringify(signals).includes('private-error-detail'));
}

if(process.env.TABPLAYER_OBSERVER_FALLBACK_RED==='1'){
  test('old final acceptance after last-mix fallback must fail (expected RED)',()=>lateFallbackCase(()=>{}));
}else if(process.env.TABPLAYER_OBSERVER_RED==='1'){
  test('old immutable-invoke replacement must observe actual native mix (expected RED)',async()=>{
    const f=fixture();
    // Original observer mechanism, evaluated without strict mode as in the retained failing WebView.
    vm.runInNewContext(`(()=>{const api=window.__TAURI_INTERNALS__,original=api.invoke.bind(api);window.__processingEvidence={mix:[]};api.invoke=async(command,args)=>{if(command==='audio_set_mix')window.__processingEvidence.mix.push({args});return original(command,args);};})()`,{window:f.window});
    await f.api.invoke('audio_set_mix',{settings:{backing:{processing:{semitones:1,cents:0,filter:'none'}}},generation:7});
    assert.equal(f.calls.length,1,'The immutable original still sends the real request');
    assert.equal(f.window.__processingEvidence.mix.length,1,'Old replacement fails to observe native traffic');
  });
}else{
  test('serialized installer gates edits on normal immutable invoke probe',async()=>{
    const f=fixture(),originalInvoke=f.api.invoke,receipt=await f.install();
    assert.equal(f.api.invoke,originalInvoke);assert.notEqual(f.window.fetch,f.transport);assert.equal(receipt.fetchIdentityVerified,true);assert.equal(receipt.invokeDescriptor.writable,false);
    assert.equal(f.calls.length,1);assert.equal(receipt.probe.postJson,true);assert.equal(receipt.probe.nativeResponse,'ok');assert.deepEqual(JSON.parse(JSON.stringify(receipt.probe.result)),f.status);assert.equal(f.window.__processingEvidence.capable,true);
    await f.api.invoke('audio_status');assert.equal(f.window.__processingEvidence.probe.length,1,'Only one probe record');
    assert.ok(!JSON.stringify(f.window.__processingEvidence).includes('never-copy-this-header'));
  });
  test('mix and prepare forward exact request once and return original native Response',async()=>{
    const f=fixture();await f.install();
    for(const command of ['audio_set_mix','audio_prepare']){
      const input=f.api.convertFileSrc(command,'ipc'),init={method:'POST',body:JSON.stringify({settings:{backing:{processing:{semitones:12,cents:-50,filter:'none'}}},generation:7}),headers:{private:'not-recorded'}};
      const count=f.calls.length,response=await f.window.fetch(input,init);assert.equal(f.calls.length,count+1);assert.equal(f.calls.at(-1)[0],input);assert.equal(f.calls.at(-1)[1],init);assert.equal(response,f.responses.at(-1));
      const row=f.window.__processingEvidence[command==='audio_set_mix'?'mix':'prepare'].at(-1);assert.equal(row.nativeAcknowledged,true);assert.equal(row.nativeResponse,'ok');assert.equal(row.result,null);assert.equal(row.args.settings.backing.processing.cents,-50);
    }
    const init={method:'GET'},count=f.calls.length,response=await f.window.fetch('http://unrelated.local/other',init);assert.equal(f.calls.length,count+1);assert.equal(f.calls.at(-1)[1],init);assert.equal(response,f.responses.at(-1));assert.equal(f.window.__processingEvidence.mix.length,1);
  });
  test('native error, missing header and non-null mix result never count as successful acknowledgment',async()=>{
    for(const header of ['error',null,'unexpected','ok']){
      const f=fixture({mixHeader:header,mixResult:'refused'});await f.install();const count=f.calls.length;
      const response=await f.window.fetch(f.api.convertFileSrc('audio_set_mix','ipc'),{method:'POST',body:'{}'});
      assert.equal(f.calls.length,count+1);assert.equal(response,f.responses.at(-1));const row=f.window.__processingEvidence.mix[0];assert.equal(row.nativeAcknowledged,false);assert.equal(row.nativeResponse,header);if(header==='error')assert.equal(row.nativeError,'native failure');
    }
    for(const header of ['error',null]){const f=fixture({header});await assert.rejects(f.install());assert.equal(f.window.__processingEvidence.capable,false);assert.equal(f.calls.length,1);}
  });
  test('clone or payload diagnostic error after forwarding never rejects or duplicates request',async()=>{
    const f=fixture({cloneError:true});await f.install();const init={method:'POST',body:'{}'},count=f.calls.length,response=await f.window.fetch(f.api.convertFileSrc('audio_set_mix','ipc'),init);
    assert.equal(f.calls.length,count+1);assert.equal(response,f.responses.at(-1));assert.equal(f.window.__processingEvidence.mix[0].nativeAcknowledged,false);assert.match(f.window.__processingEvidence.mix[0].diagnosticError,/clone diagnostic failure/);assert.equal(await response.json(),null);
    const invalid={method:'POST',body:'invalid JSON'},before=f.calls.length,r=await f.window.fetch(f.api.convertFileSrc('apply_edit','ipc'),invalid);assert.equal(f.calls.length,before+1);assert.equal(r,f.responses.at(-1));assert.equal(f.calls.at(-1)[1],invalid);assert.ok(f.window.__processingEvidence.edits[0].diagnosticError);
  });
  test('hold only setBacking before delegate; repeat release forwards original request once',async()=>{
    const f=fixture();await f.install();const evidence=f.window.__processingEvidence;evidence.hold=true;
    await f.api.invoke('apply_edit',{command:{type:'setTitle',title:'unheld'}});assert.equal(evidence.hold,true);
    const input=f.api.convertFileSrc('apply_edit','ipc'),init={method:'POST',body:JSON.stringify({document:{documentId:'owned',revision:1},command:{type:'setBacking',backing:{processing:null}}})},count=f.calls.length;
    const pending=f.window.fetch(input,init);assert.equal(f.calls.length,count);assert.equal(typeof evidence.release,'function');evidence.release();evidence.release();const response=await pending;
    assert.equal(f.calls.length,count+1);assert.equal(f.calls.at(-1)[0],input);assert.equal(f.calls.at(-1)[1],init);assert.equal(response,f.responses.at(-1));assert.equal(evidence.edits.at(-1).nativeAcknowledged,true);
  });
  test('identity refusal and unsupported fallback fail capability before mutation',async()=>{
    const locked=fixture({fetchWritable:false});await assert.rejects(locked.install(),/identity mismatch|installation refused/);assert.equal(locked.calls.length,0);
    const fallback=fixture({fallback:true});await assert.rejects(fallback.install(),/transport probe failed/);assert.equal(fallback.calls.length,0);assert.equal(fallback.window.__processingEvidence.capable,false);
  });
  test('late fallback after successful probe and final mix prevents next edit and passed acceptance',()=>lateFallbackCase());
  test('warning matching is narrow and fallback persists across phases and cleanup',async()=>{
    const signals=[],first=new EventEmitter(),last=new EventEmitter();observeTauriFallback(first,signals,'first');observeTauriFallback(last,signals,'last');
    const warning='IPC custom protocol failed, Tauri will now use the postMessage interface instead';
    for(const [type,text]of [['warning','An unrelated warning'],['log',warning],['warning','IPC custom protocol succeeded'],['warning',`prefix ${warning}`]])first.emit('console',{type:()=>type,text:()=>text});assert.doesNotThrow(()=>assertNoTauriFallback(signals));
    last.emit('console',{type:()=> 'warning',text:()=>warning});assert.throws(()=>assertNoTauriFallback(signals));
    // No later mix or edit is required: final/cleanup guard reads the same persistent receipt array.
    first.removeAllListeners();last.removeAllListeners();assert.throws(()=>assertNoTauriFallback(signals));assert.deepEqual(signals,[{phase:'last',kind:'tauri-ipc-postmessage-fallback'}]);
  });
}
