import { beforeEach,expect,it,vi } from 'vitest';
import { putTuningLibraryEntry,readTuningLibrary,removeTuningLibraryEntry,subscribeTuningLibrary,tuningNameError,type SavedTuning,type TuningLibrary } from './library';

const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke}));
const id='ca4af764-86e2-4ddd-9c26-a1be3368bdf7',other='0f3b6f0e-1111-4222-8333-944455556666';
const entry=(over:Partial<SavedTuning>={}):SavedTuning=>({id,name:'Open D',tuning:[62,57,54,50,45,38],...over});
const library=(entries:SavedTuning[]=[]):TuningLibrary=>({format:'tabplayer-tuning-library',version:1,entries});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
beforeEach(()=>invoke.mockReset());

it('uses exactly the typed native commands and payloads',async()=>{
  const stored=library([entry()]);invoke.mockResolvedValueOnce(library()).mockResolvedValueOnce(stored).mockResolvedValueOnce(library());
  expect(await readTuningLibrary()).toEqual(library());expect(await putTuningLibraryEntry(entry())).toEqual(stored);expect(await removeTuningLibraryEntry(id)).toEqual(library());
  expect(invoke.mock.calls).toEqual([['tuning_library_read'],['tuning_library_put',{entry:entry()}],['tuning_library_remove',{id}]]);
});
it('trims names before put and clones inbound and outbound values',async()=>{
  const input=entry({name:'  Open D  '}),stored=library([entry()]);invoke.mockResolvedValueOnce(stored);
  const result=await putTuningLibraryEntry(input);
  expect(invoke.mock.calls[0][1].entry).toEqual(entry());expect(invoke.mock.calls[0][1].entry).not.toBe(input);expect(input.name).toBe('  Open D  ');
  expect(result).toEqual(stored);expect(result).not.toBe(stored);expect(result.entries[0].tuning).not.toBe(stored.entries[0].tuning);
  result.entries[0].tuning[0]=1;expect(stored.entries[0].tuning[0]).toBe(62);
});
it('rejects invalid entries and ids before any native call',async()=>{
  for(const change of [{name:''},{name:'   '},{name:'x'.repeat(81)},{name:'\u0001bad'},{name:'a\uD800b'},{tuning:[]},{tuning:Array(13).fill(60)},{tuning:[60,128]},{tuning:[-1]},{tuning:[60.5]},{id:'../x'},{extra:1}]){
    await expect(putTuningLibraryEntry({...entry(),...change} as SavedTuning)).rejects.toThrow();
  }
  await expect(removeTuningLibraryEntry('nope')).rejects.toThrow();expect(invoke).not.toHaveBeenCalled();
});
it('counts Unicode scalar values and accepts valid XML text',async()=>{
  expect(tuningNameError('🎸'.repeat(80))).toBeNull();expect(tuningNameError('🎸'.repeat(81))).not.toBeNull();expect(tuningNameError('Öine & <hääl> ]]>')).toBeNull();expect(tuningNameError('a\tb')).toBeNull();expect(tuningNameError('a￾b')).not.toBeNull();
  for(const edge of [String.fromCharCode(0x85),String.fromCharCode(0xFEFF)])for(const name of [edge+'x','x'+edge])expect(tuningNameError(name)).not.toBeNull();
});
it('rejects malformed native responses',async()=>{
  for(const value of [null,{...library(),extra:1},{...library(),version:2},{...library(),format:'x'},library([entry({tuning:[]})]),library([entry({name:' padded '})]),library([entry(),entry({id:id.toUpperCase()})]),{format:'tabplayer-tuning-library',version:1,entries:[{id,name:'a'}]}]){
    invoke.mockResolvedValueOnce(value);await expect(readTuningLibrary()).rejects.toThrow();
  }
});
it('serializes reads and mutations so an old read cannot publish after a newer write',async()=>{
  const first=deferred<TuningLibrary>(),seen:TuningLibrary[]=[],stop=subscribeTuningLibrary(value=>seen.push(value));
  invoke.mockReturnValueOnce(first.promise).mockResolvedValueOnce(library([entry()]));
  const read=readTuningLibrary(),write=putTuningLibraryEntry(entry());await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(1);first.resolve(library());
  await read;await write;expect(invoke.mock.calls.map(call=>call[0])).toEqual(['tuning_library_read','tuning_library_put']);
  expect(seen).toEqual([library(),library([entry()])]);stop();
});
it('recovers after a rejected operation and notifies only successful snapshots',async()=>{
  const seen:TuningLibrary[]=[],stop=subscribeTuningLibrary(value=>seen.push(value));
  invoke.mockRejectedValueOnce('disk full').mockResolvedValueOnce({bad:true}).mockResolvedValueOnce(library([entry({id:other})]));
  const a=putTuningLibraryEntry(entry()),b=readTuningLibrary(),c=removeTuningLibraryEntry(id);
  await expect(a).rejects.toBe('disk full');await expect(b).rejects.toThrow();await expect(c).resolves.toEqual(library([entry({id:other})]));
  expect(seen).toEqual([library([entry({id:other})])]);stop();
});
it('gives each subscriber its own clone and stops after unsubscribe',async()=>{
  const a=vi.fn(value=>{value.entries.length=0;}),b=vi.fn(),stopA=subscribeTuningLibrary(a),stopB=subscribeTuningLibrary(b);
  invoke.mockResolvedValue(library([entry()]));await readTuningLibrary();expect(b).toHaveBeenLastCalledWith(library([entry()]));
  stopA();stopB();await readTuningLibrary();expect(a).toHaveBeenCalledTimes(1);expect(b).toHaveBeenCalledTimes(1);
});
