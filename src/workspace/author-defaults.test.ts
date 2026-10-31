import { expect,it } from 'vitest';
import { authorDefaultsLimit,clipAuthorText,emptyAuthorDefaults,newScoreDefaults,readAuthorDefaults,writeAuthorDefaults } from './author-defaults';

const memory=()=>{const values=new Map<string,string>();return {values,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};};

it('starts empty and round-trips every author field',()=>{
  const storage=memory();
  expect(readAuthorDefaults(storage)).toEqual(emptyAuthorDefaults);
  const defaults={artist:'The Band',words:'Ann Lyric',music:'Ben Tune',tab:'Cy Transcriber',copyright:'© 2026 The Band'};
  writeAuthorDefaults(defaults,storage);
  expect(readAuthorDefaults(storage)).toEqual(defaults);
  expect([...storage.values.keys()]).toEqual(['tabplayer.authorDefaults']);
});

it('keeps only known string fields within the limit from damaged storage',()=>{
  const storage=memory();
  storage.values.set('tabplayer.authorDefaults',JSON.stringify({artist:'A',words:7,music:null,tab:'x'.repeat(authorDefaultsLimit+5),extra:'no'}));
  expect(readAuthorDefaults(storage)).toEqual({...emptyAuthorDefaults,artist:'A',tab:'x'.repeat(authorDefaultsLimit)});
  for(const raw of ['not json','[]','null','"text"']){storage.values.set('tabplayer.authorDefaults',raw);expect(readAuthorDefaults(storage)).toEqual(emptyAuthorDefaults);}
});

it('never throws when storage is unavailable',()=>{
  const broken={getItem:()=>{throw new Error('denied');},setItem:()=>{throw new Error('denied');}};
  expect(readAuthorDefaults(broken)).toEqual(emptyAuthorDefaults);
  expect(writeAuthorDefaults({...emptyAuthorDefaults,artist:'A'},broken)).toBe(false);
  expect(readAuthorDefaults(undefined)).toEqual(emptyAuthorDefaults);
});

it('applies the last saved defaults to new scores even when storage refused them',()=>{
  const broken={getItem:()=>{throw new Error('denied');},setItem:()=>{throw new Error('denied');}};
  expect(writeAuthorDefaults({...emptyAuthorDefaults,tab:'Session'},broken)).toBe(false);
  expect(newScoreDefaults()).toEqual({...emptyAuthorDefaults,tab:'Session'});
});

it('never stores half a character, so the native New call keeps accepting the defaults',()=>{
  const storage=memory();
  writeAuthorDefaults({...emptyAuthorDefaults,copyright:`${'c'.repeat(999)}🎸`,tab:'a\uD800b',words:'\uDC00x'},storage);
  const stored=readAuthorDefaults(storage);
  expect(stored.copyright).toBe('c'.repeat(999));
  expect(stored.tab).toBe('a�b');expect(stored.words).toBe('�x');
  expect(Object.values(stored).every(value=>!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value))).toBe(true);
  expect(clipAuthorText('🎸'.repeat(600))).toBe('🎸'.repeat(500));
});
