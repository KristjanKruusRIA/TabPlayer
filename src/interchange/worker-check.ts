/** How long a Worker may hold a file before it is ended. A file that makes a reader spin costs a terminated Worker, not a frozen window. */
export const CHECK_DEADLINE_MS=15000;

export type CheckFailure={ok:false;error:string};
export interface CheckWorker{
  onmessage:((event:{data:unknown})=>void)|null;
  onerror:((event:{message?:string;preventDefault?:()=>void})=>void)|null;
  onmessageerror:((event:unknown)=>void)|null;
  postMessage(message:unknown,transfer?:Transferable[]):void;
  terminate():void;
}
export interface CheckOptions{
  deadlineMs?:number;
  signal?:AbortSignal;
  /** Replaces the real Worker, for tests. */
  createWorker?:()=>CheckWorker;
}
interface Job<T>{
  createWorker:()=>CheckWorker;
  /** Called once the Worker exists, so an already cancelled check never copies the file. */
  request:()=>{message:unknown;transfer:Transferable[]};
  /** The result a Worker message stands for, or undefined for traffic that is not an answer. */
  read:(data:unknown)=>T|undefined;
  deadlineError:(seconds:number)=>string;
}

/** Runs one request in a new Worker under a deadline. The Worker always ends with the check. */
export function runWorkerCheck<T extends {ok:boolean}>(job:Job<T>,options:CheckOptions={}):Promise<T|CheckFailure> {
  const {deadlineMs=CHECK_DEADLINE_MS,signal}=options;
  return new Promise(resolve=>{
    let worker:CheckWorker|null=null,timer:ReturnType<typeof setTimeout>|undefined,finished=false;
    const finish=(result:T|CheckFailure)=>{
      if(finished)return;
      finished=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();}
      resolve(result);
    };
    const cancel=()=>finish({ok:false,error:'The check was cancelled.'});
    if(signal?.aborted){cancel();return;}
    signal?.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(()=>finish({ok:false,error:job.deadlineError(Math.round(deadlineMs/1000))}),deadlineMs);
    try{
      worker=job.createWorker();
      worker.onmessage=event=>{const result=job.read(event.data);if(result!==undefined)finish(result);};
      worker.onerror=event=>{event.preventDefault?.();finish({ok:false,error:event.message?`The file check failed: ${event.message}`:'The file check failed.'});};
      worker.onmessageerror=()=>finish({ok:false,error:'The file check answer could not be read.'});
      const {message,transfer}=job.request();worker.postMessage(message,transfer);
    }catch(error){finish({ok:false,error:`The file check could not start: ${error instanceof Error?error.message:String(error)}`});}
  });
}
