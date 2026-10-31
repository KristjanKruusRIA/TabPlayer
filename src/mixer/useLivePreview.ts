import { useEffect, useState } from 'react';

const liveEveryMs=70;

function makeLive() {
  let on=false,play:(()=>unknown)|null=null,settle:(()=>unknown)|null=null,sending:Promise<unknown>|null=null,timer:ReturnType<typeof setTimeout>|null=null,last=0;
  const send=()=>{
    timer=null;if(!on||sending||!play)return;
    const run=play;play=null;last=Date.now();
    sending=(async()=>{await run();})().catch(()=>{}).finally(()=>{sending=null;if(on&&play)schedule();});
  };
  const schedule=()=>{
    if(timer||sending)return;
    const wait=Math.max(0,liveEveryMs-(Date.now()-last));
    if(wait===0)send();else timer=setTimeout(send,wait);
  };
  return {
    /** Runs `next` soon, replacing one still waiting; `after` puts things back when the gesture ends. */
    hear(next:()=>unknown,after:()=>unknown){on=true;play=next;settle=after;schedule();},
    /** Drops what waits, lets the request in flight finish, then runs `after` unless `keep` or a new gesture began. */
    end(options:{keep?:boolean}={}):Promise<void> {
      if(!on)return Promise.resolve();
      on=false;play=null;if(timer){clearTimeout(timer);timer=null;}
      const back=settle;settle=null;
      return Promise.resolve(sending).then(()=>{if(!on&&!options.keep&&back)return back();}).catch(()=>{}).then(()=>undefined);
    },
  };
}

/** Lets a control that is being dragged play as it moves, at most once every 70 ms, one request at a time, newest first.
 * Nothing is recorded; a control that goes away ends its gesture. */
export function useLivePreview() {
  const [live]=useState(makeLive);
  useEffect(()=>()=>{void live.end();},[live]);
  return live;
}
