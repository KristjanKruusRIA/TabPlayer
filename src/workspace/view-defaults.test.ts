import { afterEach,expect,it } from 'vitest';
import { forgetSessionViewDefaults,standardViewDefaults,readViewDefaults,writeViewDefaults,viewDefaultsFrom,defaultDocumentView } from './view-defaults';
import { initialDocumentView } from './view-state';

afterEach(forgetSessionViewDefaults);
const memory=()=>{const values=new Map<string,string>();return {values,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};};

it('starts at the standard view and round-trips saved defaults',()=>{
  const storage=memory();
  expect(readViewDefaults(storage)).toEqual(standardViewDefaults);
  expect(standardViewDefaults).toEqual({layout:'parchment',zoomMode:'manual',zoom:100,tracks:'selected'});
  const defaults={layout:'verticalPage',zoomMode:'fitPage',zoom:140,tracks:'all'} as const;
  expect(writeViewDefaults(defaults,storage)).toBe(true);
  expect(readViewDefaults(storage)).toEqual(defaults);
  expect([...storage.values.keys()]).toEqual(['tabplayer.viewDefaults']);
});

it('repairs damaged storage field by field',()=>{
  const storage=memory();
  storage.values.set('tabplayer.viewDefaults',JSON.stringify({layout:'grid',zoomMode:'sideways',zoom:999,tracks:'custom',extra:1}));
  expect(readViewDefaults(storage)).toEqual({layout:'grid',zoomMode:'manual',zoom:100,tracks:'selected'});
  storage.values.set('tabplayer.viewDefaults',JSON.stringify({layout:'verticalScreen',zoomMode:'fitPage',zoom:25,tracks:'all'}));
  expect(readViewDefaults(storage)).toEqual({layout:'verticalScreen',zoomMode:'fitWidth',zoom:25,tracks:'all'});
  for(const raw of ['nope','[]','null','7']){storage.values.set('tabplayer.viewDefaults',raw);expect(readViewDefaults(storage)).toEqual(standardViewDefaults);}
  const broken={getItem:()=>{throw new Error('denied');},setItem:()=>{throw new Error('denied');}};
  expect(readViewDefaults(broken)).toEqual(standardViewDefaults);expect(readViewDefaults(undefined)).toEqual(standardViewDefaults);
});

it('captures a current view, keeping custom track lists per score',()=>{
  expect(viewDefaultsFrom({zoom:180,trackView:{kind:'custom',trackIds:['a']},scoreDisplay:{layout:'horizontalScreen',zoomMode:'manual'}})).toEqual({layout:'horizontalScreen',zoomMode:'manual',zoom:180,tracks:'selected'});
  expect(viewDefaultsFrom({zoom:90,trackView:{kind:'all'}})).toEqual({layout:'parchment',zoomMode:'manual',zoom:90,tracks:'all'});
});

it('builds the first view of a score from the defaults and keeps the standard view without them',()=>{
  expect(defaultDocumentView(standardViewDefaults)).toEqual({target:{track:0,staff:0,bar:0,voice:0,beat:0},selectedString:6,selectedNoteIndex:null,zoom:100,trackView:{kind:'selected'},instrumentVisible:false});
  expect(defaultDocumentView({layout:'verticalPage',zoomMode:'fitPage',zoom:140,tracks:'all'})).toMatchObject({zoom:140,trackView:{kind:'all'},scoreDisplay:{layout:'verticalPage',zoomMode:'fitPage'}});
});

it('applies the last saved defaults even when storage refused them',()=>{
  const broken={getItem:()=>{throw new Error('denied');},setItem:()=>{throw new Error('denied');}};
  expect(writeViewDefaults({layout:'grid',zoomMode:'fitWidth',zoom:75,tracks:'all'},broken)).toBe(false);
  expect(initialDocumentView()).toMatchObject({zoom:75,trackView:{kind:'all'},scoreDisplay:{layout:'grid',zoomMode:'fitWidth'}});
});

it('forgets the session copy between tests',()=>{
  expect(initialDocumentView()).toEqual(defaultDocumentView(standardViewDefaults));
});
