import { nativeLineIn,type LineInBridge,type LineInSettings,type LineInStatus } from './line-in';

/** Why the Line-In is not doing what was asked; `detail` is the native message. */
export interface LineInProblem {kind:'failed'|'stopped'|'set_failed';detail:string}
export interface LineInSessionState {running:boolean;pending:boolean;status:LineInStatus|null;problem:LineInProblem|null}
export interface LineInSession {
  subscribe(listener:()=>void):()=>void;
  get():LineInSessionState;
  /** Starts monitoring `inputId` with `settings`, or moves running monitoring to it. */
  start(inputId:string,settings:LineInSettings):Promise<void>;
  stop():Promise<void>;
  /** Sends a sound or level change. Only the newest change matters, so changes made while one is on its way replace each other. */
  update(settings:LineInSettings):Promise<void>;
  /** Ends polling and listeners; for tests. */
  dispose():void;
}
const detail=(error:unknown)=>error instanceof Error?error.message:String(error);

/**
 * The Line-In outlives the panel that shows it: the workspace remounts the whole editor when the active document
 * changes, and monitoring must carry on through that (A29). So the session, its polling and its errors live here,
 * once per app, and the panel only displays and drives it.
 */
export function createLineInSession(bridge:LineInBridge,interval=200):LineInSession {
  let state:LineInSessionState={running:false,pending:false,status:null,problem:null};
  let session:number|null=null,timer:ReturnType<typeof setTimeout>|null=null,disposed=false,generation=0,stops=0;
  let inFlight:Promise<void>|null=null,queued:LineInSettings|null=null;
  /** An input chosen while a start was on its way, applied when that start finishes. */
  let restart:{inputId:string;settings:LineInSettings}|null=null;
  const listeners=new Set<()=>void>();
  const set=(next:Partial<LineInSessionState>)=>{state={...state,...next};for(const listener of listeners)listener();};
  const poll=()=>{
    if(timer!==null)clearTimeout(timer);
    timer=setTimeout(async()=>{
      timer=null;if(disposed||!state.running)return;
      const seen=generation;
      try{
        const status=await bridge.status();if(seen!==generation||disposed)return;
        if(!status.running){session=null;set({running:false,status:null,problem:status.error?{kind:'stopped',detail:status.error}:null});return;}
        set({status});
      }catch{/* A missed status read only delays the meter. */}
      if(state.running)poll();
    },interval);
  };
  /** Sends the newest settings, one call at a time, so a slow call never lands after a newer one. */
  const flush=():Promise<void>=>{
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      try{
        while(queued){const next=queued;queued=null;await bridge.set(next);}
      }finally{inFlight=null;}
    })();
    return inFlight;
  };
  const update=async(settings:LineInSettings)=>{
    queued=settings;
    try{await flush();if(state.problem?.kind==='set_failed')set({problem:null});}
    catch(error){
      set({problem:{kind:'set_failed',detail:detail(error)}});
      // A newer change that queued behind the failed one is still sent.
      if(queued)void update(queued);
    }
  };
  const stopNative=async()=>{const previous=session;session=null;generation++;if(timer!==null){clearTimeout(timer);timer=null;}set({running:false,status:null});await bridge.stop(previous);};
  const start=async(inputId:string,settings:LineInSettings):Promise<void>=>{
    if(state.pending){restart={inputId,settings};return;}
    // Only the user's Stop counts here; the stop of the old capture when moving to a new input does not.
    const mine=stops,overtaken=()=>mine!==stops||disposed;
    set({pending:true,problem:null});
    try{
      if(state.running)await stopNative();
      if(overtaken())return;
      // The sound and level are in place before the first sample is heard.
      queued=settings;await flush();
      if(overtaken())return;
      const started=await bridge.start(inputId||null);
      // A stop while this start was on its way wins.
      if(overtaken()){await bridge.stop(started);return;}
      session=started;generation++;set({running:true});poll();
    }catch(error){
      if(session!==null)void bridge.stop(session).catch(()=>{});
      session=null;
      // A start ended by Stop is not a failure, whatever the native side said about it.
      set({running:false,status:null,problem:overtaken()?null:{kind:'failed',detail:detail(error)}});
    }finally{set({pending:false});}
    const again=restart;restart=null;
    if(again&&state.running)await start(again.inputId,again.settings);
  };
  const stop=async()=>{stops++;restart=null;try{await stopNative();}catch(error){set({problem:{kind:'failed',detail:detail(error)}});}};
  // After a reload the native side may still be monitoring; pick it up so it can be seen and stopped.
  void bridge.status().then(status=>{if(!disposed&&status.running&&!state.running&&!state.pending){set({running:true,status});poll();}}).catch(()=>{});
  return {
    subscribe:listener=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},
    get:()=>state,
    start,stop,update,
    dispose:()=>{disposed=true;if(timer!==null)clearTimeout(timer);listeners.clear();},
  };
}

let shared:LineInSession|null=null;
/** The app's one Line-In session. */
export const lineInSession=():LineInSession=>shared??=createLineInSession(nativeLineIn);
