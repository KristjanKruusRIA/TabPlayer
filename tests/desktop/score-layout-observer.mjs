// Every browser entrypoint is self-contained: Playwright serializes its source.
export async function installScoreLayoutIpcObserver(){
  const state=window.__scoreLayoutAcceptance??={publicApi:null,generation:0,completedGeneration:null,chunks:[],apiRenders:0,highlights:[],calls:[],failures:[],capable:false,_cleanups:[],_active:true};
  if(state._ipcInstalled)throw Error('Score layout IPC observer already installed');
  const api=window.__TAURI_INTERNALS__,original=window.fetch;
  if(typeof original!=='function'||typeof api?.invoke!=='function'||typeof api?.convertFileSrc!=='function')throw Error('Score layout transport unavailable');
  const urls=new Map(['audio_prepare','audio_command','audio_set_mix','apply_edit','workspace_set_view','audio_status'].map(command=>[api.convertFileSrc(command,'ipc'),command]));
  const descriptor=Object.getOwnPropertyDescriptor(window,'fetch'),invoke=Object.getOwnPropertyDescriptor(api,'invoke');
  const invokeDescriptor={own:Boolean(invoke),writable:invoke?.writable===true,configurable:invoke?.configurable===true,enumerable:invoke?.enumerable===true};
  const copy=value=>JSON.parse(JSON.stringify(value));
  const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value&&Object.hasOwn(value,key)).map(key=>[key,copy(value[key])]));
  const payload=(command,args)=>{
    if(command==='workspace_set_view')return {...pick(args,['documentId']),...(args.view?{view:pick(args.view,['target','selectedString','selectedNoteIndex','zoom','trackView','instrumentVisible','scoreDisplay','keyboardVisible'])}:{})};
    if(command==='apply_edit')return {...pick(args,['document']),...(args.command?{command:pick(args.command,['type','selection','semitones','direction','layout'])}:{})};
    if(command==='audio_command')return {...pick(args,['owner']),...(args.command?{command:pick(args.command,['type','tick','generation','range','loop'])}:{})};
    return pick(args,['owner','generation']);
  };
  let probe=null,probing=true,active=true;
  const failure=(kind,row)=>{state.failures.push({kind,command:row.command,...(row.id?{id:row.id}:{})});};
  const wrapper=async function(...args){
    const [input,init]=args,command=urls.get(typeof input==='string'?input:input?.url);
    if(!active||!command||command==='audio_status'&&(!probing||probe))return original.apply(this,args);
    const row={id:command==='audio_status'?0:state.calls.length+1,command,payload:null,settled:false,ok:null,result:null};
    if(command==='audio_status')probe=row;else state.calls.push(row);
    let valid=true;
    try{if(init?.method!=='POST'||typeof init.body!=='string')throw Error();const parsed=JSON.parse(init.body);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();row.payload=command==='audio_status'?{}:payload(command,parsed);}catch{valid=false;failure('request-diagnostic',row);}
    let response;
    try{response=await original.apply(this,args);}catch(error){row.settled=true;row.ok=false;failure('transport-rejected',row);throw error;}
    // No diagnostic after forwarding may reject: that would authorize Tauri to resend.
    try{
      const result=await response.clone().json(),ok=response.headers.get('Tauri-Response')==='ok';
      if(command==='audio_status')row.result=copy(result);
      else if(command==='apply_edit'&&result&&typeof result==='object'&&!Array.isArray(result))row.result=pick(result,['documentId','revision','snapshot']);
      else row.result=result===null?null:{unexpected:true};
      const expected=command==='audio_status'?result&&typeof result==='object'&&!Array.isArray(result)&&typeof result.ready==='boolean'&&typeof result.playing==='boolean'&&Number.isInteger(result.generation)&&Number.isInteger(result.desiredGeneration)&&Number.isFinite(result.tick)&&Number.isFinite(result.seconds)&&result.error===null:
        command==='apply_edit'?result&&typeof result==='object'&&!Array.isArray(result)&&result.documentId===row.payload?.document?.documentId&&Number.isInteger(result.revision)&&result.revision>=0&&result.snapshot&&typeof result.snapshot==='object'&&!Array.isArray(result.snapshot):result===null;
      row.ok=Boolean(valid&&ok&&expected);if(!row.ok)failure('native-acknowledgement',row);
    }catch{row.ok=false;failure('response-diagnostic',row);}
    row.settled=true;return response;
  };
  try{Object.defineProperty(window,'fetch',descriptor&&'value'in descriptor?{...descriptor,value:wrapper}:{value:wrapper,writable:true,configurable:descriptor?.configurable??true,enumerable:descriptor?.enumerable??true});}
  catch{throw Error('Score layout fetch observer installation refused');}
  if(window.fetch!==wrapper)throw Error('Score layout fetch observer identity mismatch');
  state._ipcInstalled=true;
  state._cleanups.push(()=>{active=false;state._ipcInstalled=false;state._ipcReady=false;if(Object.getOwnPropertyDescriptor(window,'fetch')?.value!==wrapper)return false;if(descriptor)Object.defineProperty(window,'fetch',descriptor);else delete window.fetch;return true;});
  try{
    const returned=await api.invoke('audio_status',{});probing=false;
    if(window.fetch!==wrapper||!probe?.ok||!probe.settled||JSON.stringify(probe.result)!==JSON.stringify(returned))throw Error('Score layout native probe failed');
    state._ipcReady=true;state.capable=Boolean(state.publicApi&&state._apiInstalled);return {probe:copy(probe),invokeDescriptor,fetchIdentityVerified:true};
  }catch(error){probing=false;state.capable=false;throw error;}
}

export async function installScoreLayoutApiObserver(){
  const state=window.__scoreLayoutAcceptance??={publicApi:null,generation:0,completedGeneration:null,chunks:[],apiRenders:0,highlights:[],calls:[],failures:[],capable:false,_cleanups:[],_active:true};
  if(state._apiInstalled)throw Error('Score layout API observer already installed');
  const {AlphaTabApi}=await import('/alphatab/alphaTab.mjs');
  const prototype=AlphaTabApi?.prototype,original=prototype?.renderScore;
  if(typeof original!=='function')throw Error('Public AlphaTabApi renderScore unavailable');
  const descriptor=Object.getOwnPropertyDescriptor(prototype,'renderScore'),apis=new Set();let active=true;
  const fail=kind=>state.failures.push({kind});
  const wrap=(owner,key,record)=>{
    const own=Object.getOwnPropertyDescriptor(owner,key),method=owner[key];if(typeof method!=='function')throw Error('Public facade method unavailable');
    const wrapped=function(...args){if(active)try{record(args);}catch{fail('highlight-diagnostic');}return method.apply(this,args);};
    Object.defineProperty(owner,key,own?{...own,value:wrapped}:{value:wrapped,writable:true,enumerable:true,configurable:true});
    state._cleanups.push(()=>{const held=owner;owner=null;if(Object.getOwnPropertyDescriptor(held,key)?.value!==wrapped)return false;if(own)Object.defineProperty(held,key,own);else delete held[key];return true;});
  };
  const attach=api=>{
    if(apis.has(api))return;apis.add(api);
    const holder={api};
    const current=()=>active&&holder.api===state.publicApi;
    const started=()=>{if(current()){state.generation++;state.completedGeneration=null;state.chunks=[];state.highlights=[];}};
    const partial=args=>{if(!current())return;try{
      if(typeof args.id!=='string'||typeof args.renderResult!=='string'||!['x','y','width','height','firstMasterBarIndex','lastMasterBarIndex'].every(key=>Number.isFinite(args[key])))throw Error();
      const chunk={generation:state.generation,id:args.id,x:args.x,y:args.y,width:args.width,height:args.height,firstMasterBarIndex:args.firstMasterBarIndex,lastMasterBarIndex:args.lastMasterBarIndex,svg:args.renderResult};
      const index=state.chunks.findIndex(c=>c.id===chunk.id);if(index<0)state.chunks.push(chunk);else state.chunks[index]=chunk;
    }catch{fail('chunk-diagnostic');}};
    const finished=()=>{if(current())state.completedGeneration=state.generation;};
    for(const [name,listener]of [['renderStarted',started],['partialRenderFinished',partial],['postRenderFinished',finished]]){
      const event=api[name];if(typeof event?.on!=='function'||typeof event?.off!=='function')throw Error('Public render event unavailable');event.on(listener);state._cleanups.push(()=>{event.off(listener);return true;});
    }
    state._cleanups.push(()=>{holder.api=null;return true;});
    wrap(api.uiFacade,'highlightElements',args=>{if(current()){if(typeof args[0]!=='string'||!Number.isInteger(args[1]))throw Error();state.highlights.push({generation:state.generation,kind:'highlight',groupId:args[0],masterBarIndex:args[1]});}});
    wrap(api.uiFacade,'removeHighlights',()=>{if(current())state.highlights.push({generation:state.generation,kind:'remove'});});
  };
  const wrapped=function(...args){
    if(active){state.publicApi=this;state.apiRenders++;try{attach(this);state.capable=Boolean(state._ipcReady);}catch{state.capable=false;fail('public-api-capability');}}
    return original.apply(this,args);
  };
  Object.defineProperty(prototype,'renderScore',descriptor?{...descriptor,value:wrapped}:{value:wrapped,writable:true,enumerable:false,configurable:true});
  if(prototype.renderScore!==wrapped)throw Error('Public renderScore observer identity mismatch');
  state._apiInstalled=true;state.capable=false;
  state._cleanups.push(()=>{active=false;apis.clear();state._apiInstalled=false;if(Object.getOwnPropertyDescriptor(prototype,'renderScore')?.value!==wrapped)return false;if(descriptor)Object.defineProperty(prototype,'renderScore',descriptor);else delete prototype.renderScore;return true;});
  return {installed:true};
}

export function readScoreLayoutEvidence(){
  const s=window.__scoreLayoutAcceptance;if(!s)return {capable:false,calls:[],apiRenders:0,generation:0,completedGeneration:null,chunks:[],highlights:[],failures:[]};
  return JSON.parse(JSON.stringify({capable:s.capable,calls:s.calls,apiRenders:s.apiRenders,generation:s.generation,completedGeneration:s.completedGeneration,chunks:s.chunks,highlights:s.highlights,failures:s.failures}));
}

export function disposeScoreLayoutObservers(){
  const state=window.__scoreLayoutAcceptance;if(!state)return {restored:true,released:true};
  if(state._disposed)return state._disposed;
  let restored=true,released=true;
  for(const cleanup of state._cleanups.splice(0).reverse())try{if(!cleanup())restored=false;}catch{restored=false;released=false;state.failures.push({kind:'cleanup-diagnostic'});}
  state.publicApi=null;state.capable=false;state._active=false;state._disposed={restored,released};return {...state._disposed};
}

export function observeTauriFallback(page,signals,phase){
  const listener=message=>{if(message.type()==='warning'&&message.text().startsWith('IPC custom protocol failed, Tauri will now use the postMessage interface instead'))signals.push({phase:typeof phase==='function'?phase():phase,kind:'tauri-postmessage-fallback'});};
  page.on('console',listener);return ()=>page.off('console',listener);
}
export function assertNoTauriFallback(signals){if(signals.length)throw Error('Tauri postMessage fallback invalidates score layout acceptance');}
