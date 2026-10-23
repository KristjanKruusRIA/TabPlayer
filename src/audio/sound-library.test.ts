import {afterEach,expect,it} from 'vitest';
import {soundPreset} from './SoundPanel';
import {copiedPedal,copiedSound,copyPedal,copySound,deleteSoundPreset,forgetSessionSoundLibrary,readSoundLibrary,renameSoundPreset,saveSoundPreset,soundLibrary} from './sound-library';
import {soundProblem} from '../document-settings';

/** An in-memory stand-in for the webview's local storage. */
function memory(refuse=false){
  const data=new Map<string,string>();
  return {data,getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{if(refuse)throw new Error('quota');data.set(key,value);}};
}
afterEach(()=>forgetSessionSoundLibrary());

it('saves, replaces, renames and deletes named sounds, sorted by name',()=>{
  const storage=memory(),lead=soundPreset('lead'),crunch=soundPreset('crunch');
  expect(saveSoundPreset('  Solo lead ',lead,storage)).toEqual({ok:true,replaced:false,stored:true});
  expect(saveSoundPreset('Rhythm',crunch,storage).ok).toBe(true);
  expect(readSoundLibrary(storage).map(entry=>entry.name)).toEqual(['Rhythm','Solo lead']);
  // The same name in another case replaces the sound and keeps the new spelling.
  const brighter=structuredClone(crunch);brighter.effects.eq.highDb=4;
  expect(saveSoundPreset('rhythm',brighter,storage)).toEqual({ok:true,replaced:true,stored:true});
  expect(readSoundLibrary(storage).find(entry=>entry.name==='rhythm')?.sound.effects.eq.highDb).toBe(4);
  expect(renameSoundPreset('Solo lead','Lead',storage)).toEqual({ok:true,stored:true});
  expect(renameSoundPreset('Lead','RHYTHM',storage)).toEqual({ok:false,error:'A saved sound named “RHYTHM” already exists.'});
  expect(deleteSoundPreset('rhythm',storage)).toEqual({ok:true,stored:true});
  expect(deleteSoundPreset('rhythm',storage)).toEqual({ok:false,error:'No saved sound is named “rhythm”.'});
  // What was stored, not a copy held in memory, is what the next launch sees.
  forgetSessionSoundLibrary();
  expect(JSON.parse(storage.data.get('tabplayer.soundLibrary')!).map((entry:{name:string})=>entry.name)).toEqual(['Lead']);
  expect(readSoundLibrary(storage).map(entry=>entry.name)).toEqual(['Lead']);
  expect(saveSoundPreset('   ',lead,storage)).toEqual({ok:false,error:'Name the sound.'});
  expect(saveSoundPreset('x'.repeat(61),lead,storage)).toEqual({ok:false,error:'Use a name of 60 characters or fewer.'});
});

it('drops stored entries that are malformed or carry invalid sounds, and fills missing blocks',()=>{
  const storage=memory(),good=soundPreset('bass') as unknown as {effects:Record<string,unknown>};
  delete good.effects.wah;
  const bad=structuredClone(soundPreset('gm'));bad.effects.pitch.semitones=40;
  storage.data.set('tabplayer.soundLibrary',JSON.stringify([{name:'Bass',sound:good},{name:'Broken',sound:bad},{name:'',sound:good},{name:'BASS',sound:good},'junk',{name:'No sound'}]));
  const library=readSoundLibrary(storage);
  expect(library.map(entry=>entry.name)).toEqual(['Bass']);
  expect(library[0].sound.effects.wah.enabled).toBe(false);
  expect(soundProblem(library[0].sound)).toBeNull();
  storage.data.set('tabplayer.soundLibrary','{not json');
  expect(readSoundLibrary(storage)).toEqual([]);
});

it('keeps saved sounds for this run when storage refuses them',()=>{
  const storage=memory(true);
  expect(saveSoundPreset('Clean',soundPreset('clean'),storage)).toEqual({ok:true,replaced:false,stored:false});
  expect(soundLibrary().map(entry=>entry.name)).toEqual(['Clean']);
  expect(renameSoundPreset('Clean','Pure',storage)).toEqual({ok:true,stored:false});
  expect(deleteSoundPreset('Pure',storage)).toEqual({ok:true,stored:false});
});

it('keeps sounds another TabPlayer window saved in the same storage',()=>{
  const storage=memory();
  saveSoundPreset('Mine',soundPreset('clean'),storage);
  // Another window adds a sound directly to the shared storage.
  const shared=JSON.parse(storage.data.get('tabplayer.soundLibrary')!);
  storage.data.set('tabplayer.soundLibrary',JSON.stringify([...shared,{name:'Theirs',sound:soundPreset('bass')}]));
  saveSoundPreset('Later',soundPreset('lead'),storage);
  expect(JSON.parse(storage.data.get('tabplayer.soundLibrary')!).map((entry:{name:string})=>entry.name)).toEqual(['Later','Mine','Theirs']);
});

it('stores again once storage accepts writes after refusing one',()=>{
  let refuse=false;const data=new Map<string,string>();
  const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{if(refuse)throw new Error('quota');data.set(key,value);}};
  saveSoundPreset('One',soundPreset('clean'),storage);
  refuse=true;
  expect(saveSoundPreset('Two',soundPreset('lead'),storage)).toMatchObject({stored:false});
  expect(saveSoundPreset('Three',soundPreset('bass'),storage)).toMatchObject({stored:false});
  refuse=false;expect(saveSoundPreset('Four',soundPreset('gm'),storage)).toMatchObject({stored:true});
  expect(JSON.parse(data.get('tabplayer.soundLibrary')!).map((entry:{name:string})=>entry.name)).toEqual(['Four','One','Three','Two']);
});

it('drops stored sounds the native player would reject, and ignores fields it does not know',()=>{
  const storage=memory(),sound=(change:(effects:Record<string,Record<string,unknown>>,whole:Record<string,unknown>)=>void)=>{const value=structuredClone(soundPreset('crunch')) as unknown as Record<string,unknown>;change(value.effects as Record<string,Record<string,unknown>>,value);return value;};
  storage.data.set('tabplayer.soundLibrary',JSON.stringify([
    {name:'Extra field',sound:sound(effects=>{effects.eq.futureKnob=3;})},
    {name:'Text drive',sound:sound(effects=>{effects.amp.drive='loud';})},
    {name:'Text enabled',sound:sound(effects=>{effects.gate.enabled='yes';})},
    {name:'Loud gate',sound:sound(effects=>{effects.gate.thresholdDb=50;})},
    {name:'Odd amp',sound:sound(effects=>{effects.amp.model='fuzz';})},
    {name:'Long delay',sound:sound(effects=>{effects.delay.quarterNotes=3;})},
    {name:'Odd voice',sound:sound((_effects,whole)=>{whole.voiceId='nope';})},
    {name:'Inherited block',sound:sound(effects=>{Object.defineProperty(effects,'constructor',{value:{enabled:false},enumerable:true});})},
  ]).replace('"name":"Extra field"','"name":"Proto block","sound":{"presetId":"gm","voiceId":null,"effects":{"__proto__":{"enabled":true}}}},{"name":"Extra field"'));
  const library=readSoundLibrary(storage);
  expect(library.map(entry=>entry.name)).toEqual(['Extra field']);
  expect(Object.keys(library[0].sound.effects.eq)).not.toContain('futureKnob');
  // Sounds this version cannot use, perhaps from a newer version, stay stored when the library changes.
  saveSoundPreset('New',soundPreset('lead'),storage);
  expect(JSON.parse(storage.data.get('tabplayer.soundLibrary')!).map((entry:{name:string})=>entry.name)).toEqual(['Extra field','New','Proto block','Text drive','Text enabled','Loud gate','Odd amp','Long delay','Odd voice','Inherited block']);
  expect(renameSoundPreset('New','odd AMP',storage)).toEqual({ok:false,error:'A saved sound named “odd AMP” already exists.'});
  expect(({} as Record<string,unknown>).enabled).toBeUndefined();
});

it('rejects invalid sounds from being saved',()=>{
  const bad=structuredClone(soundPreset('gm'));bad.effects.wah.mix=3;
  expect(soundProblem(bad)).toBe('Invalid effect parameter.');
  const odd=structuredClone(soundPreset('gm'));odd.effects.compressor.ratio=.5;
  expect(soundProblem(odd)).toBe('Invalid effect parameter.');
  expect(soundProblem({...soundPreset('gm'),voiceId:'nope'})).toBe('Unknown instrument voice.');
  expect(soundProblem({presetId:'gm',effects:soundPreset('gm').effects} as never)).toBe('Invalid sound.');
  expect(soundProblem({...soundPreset('gm'),effects:null} as never)).toBe('Invalid sound.');
  expect(soundProblem({...soundPreset('gm'),extra:1} as never)).toBe('Invalid sound.');
  expect(saveSoundPreset('Bad',bad,memory())).toEqual({ok:false,error:'Invalid effect parameter.'});
});

it('copies a whole sound or one pedal as an independent snapshot',()=>{
  expect(copiedSound()).toBeNull();expect(copiedPedal()).toBeNull();
  const lead=soundPreset('lead');copySound(lead);lead.effects.delay.mix=.9;
  expect(copiedSound()?.effects.delay.mix).toBe(soundPreset('lead').effects.delay.mix);
  copyPedal('delay',{...lead.effects.delay});lead.effects.delay.mix=.1;
  expect(copiedPedal()).toEqual({block:'delay',settings:{...soundPreset('lead').effects.delay,mix:.9}});
});
