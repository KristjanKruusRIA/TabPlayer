import type { LibraryChange,LibraryFilters,LibraryPage,LibraryQuery,LibraryScan,LibrarySection,LibrarySnapshot,LibrarySource,MetadataInput,NativeFileLibraryBridge } from './types';
import type { MetadataRunner } from './metadata-runner';
export type LibraryRunner=MetadataRunner;
export interface LibraryCallbacks {openSource(source:LibrarySource):Promise<boolean>;saveTemplate(name:string,expectedRevision:number):Promise<LibrarySnapshot>}
export interface LibraryUiState {snapshot:LibrarySnapshot|null;section:LibrarySection;query:string;page:LibraryPage|null;pageQuery:LibraryQuery|null;selectedId:string|null;scan:LibraryScan|null;scanning:boolean;pending:null|'open'|'template'|'change'|'pickRoot'|'refresh';error:string|null;notice:string|null;rootId:string|null;filters:LibraryFilters;offset:number;sort:LibraryQuery['sort']}
interface ScanJob {rootId:string;configurationRevision:number;abort:AbortController;begin:Promise<LibraryScan>;cancel:Promise<void>|null}
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
export class LibraryController {
  private state:LibraryUiState={snapshot:null,section:'recent',query:'',page:null,pageQuery:null,selectedId:null,scan:null,scanning:false,pending:null,error:null,notice:null,rootId:null,filters:{title:'',artist:'',instrument:''},offset:0,sort:'title'};
  private listeners=new Set<()=>void>();
  private drafts:Record<LibrarySection,string>={recent:'',templates:'',folders:'',examples:''};
  private disposed=false;
  private mutation=false;
  private pendingSequence=0;
  private refreshSequence=0;
  private querySequence=0;
  private indexRevision=-1;
  private scanSequence=0;
  private queryTimer:ReturnType<typeof setTimeout>|null=null;
  private job:ScanJob|null=null;
  private retiring:Promise<void>|null=null;
  private constructor(private bridge:NativeFileLibraryBridge,private runner:LibraryRunner,private callbacks:LibraryCallbacks){}
  static async create(bridge:NativeFileLibraryBridge,runner:LibraryRunner,callbacks:LibraryCallbacks):Promise<LibraryController>{const controller=new LibraryController(bridge,runner,callbacks);await controller.refresh();return controller;}
  getState=():LibraryUiState=>this.state;
  subscribe=(listener:()=>void)=>{if(!this.disposed)this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};};
  private update(patch:Partial<LibraryUiState>){if(this.disposed)return;this.state={...this.state,...patch};this.listeners.forEach(listener=>listener());}
  private accept(snapshot:LibrarySnapshot){
    if(this.disposed||snapshot.revision<(this.state.snapshot?.revision??-1))return;
    const previous=this.state.snapshot?.roots??[],rootsChanged=previous.length!==snapshot.roots.length||previous.some(root=>!snapshot.roots.some(next=>next.id===root.id&&next.configurationRevision===root.configurationRevision));
    const rootId=this.state.rootId&&snapshot.roots.some(root=>root.id===this.state.rootId)?this.state.rootId:null;
    const page=rootsChanged?null:this.state.page;
    this.update({snapshot,rootId,page,pageQuery:rootsChanged?null:this.state.pageQuery,notice:snapshot.warning});
    if(rootsChanged)this.scheduleSearch();
    if(this.job&&!snapshot.roots.some(root=>root.id===this.job!.rootId&&root.configurationRevision===this.job!.configurationRevision)){const retiring=this.retire();if(retiring)void retiring.catch(error=>this.update({error:message(error)}));}
    if(this.state.selectedId&&!this.source())this.update({selectedId:null});
  }
  private begin(pending:NonNullable<LibraryUiState['pending']>){const sequence=++this.pendingSequence;this.update({pending,error:null,notice:null});return sequence;}
  private end(sequence:number){if(sequence===this.pendingSequence)this.update({pending:null});}
  private leased(){return this.state.pending==='open'||this.state.pending==='template';}
  section(section:LibrarySection):void{if(this.disposed||this.leased())return;this.drafts[this.state.section]=this.state.query;this.update({section,query:this.drafts[section],selectedId:null,offset:0});this.scheduleSearch();}
  query(text:string,options:{rootId?:string|null;offset?:number;sort?:LibraryQuery['sort'];filters?:Partial<LibraryFilters>}={}):void{
    if(this.disposed)return;this.drafts[this.state.section]=text;
    this.update({query:text,rootId:options.rootId===undefined?this.state.rootId:options.rootId,filters:{...this.state.filters,...options.filters},sort:options.sort??this.state.sort,offset:options.offset??0,selectedId:null});this.scheduleSearch();
  }
  select(id:string|null):void{if(!this.leased())this.update({selectedId:id});}
  private source():LibrarySource|undefined{
    const {section,selectedId,snapshot,page}=this.state;if(!selectedId)return;
    if(section==='recent'&&snapshot?.recents.some(row=>row.id===selectedId))return {kind:'recent',id:selectedId};
    if(section==='templates'&&snapshot?.templates.some(row=>row.id===selectedId))return {kind:'template',id:selectedId};
    if(section==='examples'&&snapshot?.examples.some(row=>row.id===selectedId))return {kind:'example',id:selectedId};
    const row=section==='folders'?page?.rows.find(row=>row.id===selectedId):null;if(row)return {kind:'indexed',rootId:row.rootId,id:row.id};
  }
  async open(source=this.source()):Promise<boolean>{
    if(this.disposed||this.mutation||this.leased()||!source)return false;const sequence=this.begin('open');
    try {const committed=await this.callbacks.openSource(source);return !this.disposed&&committed;}
    catch(error){this.update({error:message(error)});return false;}finally{this.end(sequence);}
  }
  private async mutate(pending:'change'|'pickRoot'|'template',action:(revision:number)=>Promise<LibrarySnapshot|null>,before?:()=>Promise<void>):Promise<boolean>{
    if(this.disposed||this.mutation||this.leased()||!this.state.snapshot)return false;
    this.mutation=true;const sequence=this.begin(pending);
    try {await before?.();if(this.disposed)return false;const snapshot=await action(this.state.snapshot!.revision);if(this.disposed||!snapshot)return false;this.accept(snapshot);if(this.state.section==='folders')this.scheduleSearch();return true;}
    catch(error){const failure=message(error);try{this.accept(await this.bridge.snapshot());}catch{}this.update({error:failure});return false;}
    finally{this.mutation=false;this.end(sequence);}
  }
  async change(change:LibraryChange):Promise<void>{
    const before=change.kind==='removeRoot'?async()=>{++this.scanSequence;const retiring=this.retire();if(retiring)await retiring;}:undefined;
    await this.mutate('change',revision=>this.bridge.change(revision,change),before);
  }
  async pickRoot():Promise<void>{await this.mutate('pickRoot',revision=>this.bridge.pickRoot(revision));}
  async saveTemplate(name:string):Promise<boolean>{
    if(this.disposed||this.mutation||this.leased())return false;const trimmed=name.trim();
    if(!trimmed||Array.from(trimmed).length>120){this.update({error:'Use a template name of 1–120 characters.'});return false;}
    const saved=await this.mutate('template',revision=>this.callbacks.saveTemplate(trimmed,revision));if(saved)this.update({notice:'Template saved.'});return saved;
  }
  private scheduleSearch(){
    const sequence=++this.querySequence;if(this.queryTimer)clearTimeout(this.queryTimer);this.queryTimer=null;
    if(this.disposed||this.state.section!=='folders')return;
    this.queryTimer=setTimeout(()=>{this.queryTimer=null;void this.search(sequence);},150);
  }
  private async search(sequence:number){
    const query:LibraryQuery={rootId:this.state.rootId,text:this.state.query,...this.state.filters,sort:this.state.sort,offset:this.state.offset,limit:100};
    try {const page=await this.bridge.search(query);if(this.disposed||sequence!==this.querySequence||page.indexRevision<this.indexRevision)return;this.indexRevision=page.indexRevision;this.update({page,pageQuery:query,notice:page.warning});}
    catch(error){if(sequence===this.querySequence)this.update({error:message(error)});}
  }
  private current(job:ScanJob){return !this.disposed&&this.job===job&&!job.abort.signal.aborted&&this.state.snapshot?.roots.some(root=>root.id===job.rootId&&root.configurationRevision===job.configurationRevision);}
  private retire():Promise<void>|null{
    const job=this.job;if(!job)return this.retiring;job.abort.abort();
    const scan=this.state.scan;this.update({scanning:false,...(scan&&['enumerating','reading','parsing'].includes(scan.phase)?{scan:{...scan,phase:'cancelled' as const},notice:'Scan cancelled. The previous index is still available.'}:{})});
    if(!job.cancel)job.cancel=job.begin.then(scan=>this.bridge.scanCancel(scan.jobId),()=>{});
    const retiring=job.cancel;this.retiring=retiring;
    void retiring.then(()=>{if(this.job===job)this.job=null;if(this.retiring===retiring)this.retiring=null;},()=>{if(job.cancel===retiring)job.cancel=null;if(this.retiring===retiring)this.retiring=null;});return retiring;
  }
  async scan(rootId:string):Promise<void>{
    if(this.disposed||this.leased()||this.mutation)return;const sequence=++this.scanSequence,retiring=this.retire();
    try{if(retiring)await retiring;}catch(error){this.update({error:message(error)});return;}
    if(this.disposed||sequence!==this.scanSequence)return;const root=this.state.snapshot?.roots.find(root=>root.id===rootId);if(!root)return;
    const job:ScanJob={rootId,configurationRevision:root.configurationRevision,abort:new AbortController(),begin:Promise.resolve().then(()=>this.bridge.scanBegin(rootId)),cancel:null};this.job=job;this.update({error:null,notice:null,scan:null,scanning:true});
    try {
      const started=await job.begin;if(!this.current(job))return;this.update({scan:started});
      for(;;){
        const batch=await this.bridge.scanNext(started.jobId);if(!this.current(job))return;this.update({scan:batch.scan});
        if(batch.scan.phase==='failed')throw new Error(batch.scan.issues.join('; ')||'Folder scan failed. Refresh to try again.');
        if(batch.scan.phase==='cancelled')return;
        for(const file of batch.files){
          let input:MetadataInput;try{input=await this.bridge.scanRead(started.jobId,file.fileId);}catch(error){if(!this.current(job))return;this.update({notice:message(error)});continue;}
          if(!this.current(job))return;this.update({scan:{...this.state.scan!,phase:'parsing'}});
          const result=await this.runner.run(input,job.abort.signal);if(!this.current(job))return;
          const scan=await this.bridge.scanAccept(started.jobId,file.fileId,result);if(!this.current(job))return;this.update({scan});
        }
        if(batch.done)break;
      }
      const snapshot=await this.bridge.scanFinish(started.jobId);if(!this.current(job))return;this.accept(snapshot);this.update({scan:{...this.state.scan!,phase:'ready'}});this.scheduleSearch();
    }catch(error){if(this.current(job)){this.update({error:message(error),scan:this.state.scan?{...this.state.scan,phase:'failed'}:null});const cleanup=this.retire();if(cleanup)await cleanup.catch(()=>{});}}
    finally{if(this.job===job&&!job.abort.signal.aborted){this.job=null;this.update({scanning:false});}}
  }
  async cancelScan():Promise<void>{
    ++this.scanSequence;const scan=this.state.scan,retiring=this.retire();if(scan)this.update({scan:{...scan,phase:'cancelled'},notice:'Scan cancelled. The previous index is still available.'});
    try{if(retiring)await retiring;}catch(error){this.update({error:message(error)});}
  }
  async refresh(retry=false):Promise<void>{
    if(this.disposed)return;const refresh=++this.refreshSequence,sequence=this.state.pending?null:this.begin('refresh');
    try{const snapshot=await (retry?this.bridge.retry():this.bridge.snapshot());if(refresh!==this.refreshSequence||this.disposed)return;this.accept(snapshot);if(this.state.section==='folders')this.scheduleSearch();}
    catch(error){if(refresh===this.refreshSequence)this.update({error:message(error)});}finally{if(sequence!==null)this.end(sequence);}
  }
  dispose():void{if(this.disposed)return;this.disposed=true;++this.querySequence;++this.scanSequence;++this.refreshSequence;if(this.queryTimer)clearTimeout(this.queryTimer);const retiring=this.retire();if(retiring)void retiring.catch(()=>{});this.runner.dispose();this.listeners.clear();}
}
