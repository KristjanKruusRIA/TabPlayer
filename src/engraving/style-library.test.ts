import { beforeEach,expect,it,vi } from 'vitest';
import { defaultEngraving } from './projection';
import { defaultStyle,putStyleLibraryEntry,readStyleLibrary,removeStyleLibraryEntry,styleApplied,styleNameError,styleOf,subscribeStyleLibrary,type SavedStyle,type StyleLibrary } from './style-library';

const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke}));
const id='ca4af764-86e2-4ddd-9c26-a1be3368bdf7';
const style=()=>{const engraving=defaultEngraving();engraving.stylesheet.hideDynamics=true;engraving.stylesheet.barNumbers='hidden';engraving.systemSpacing=1.5;return engraving;};
const entry=(over:Partial<SavedStyle>={}):SavedStyle=>({id,name:'Clean',engraving:style(),...over});
const library=(entries:SavedStyle[]=[]):StyleLibrary=>({format:'tabplayer-style-library',version:3,entries});
beforeEach(()=>invoke.mockReset());

it('styleOf_drops_profiles_and_styleApplied_keeps_the_documents_own',()=>{
  const document=defaultEngraving();document.profiles=[{trackId:'a',profile:'slash'}];document.stylesheet.hideDynamics=false;
  const saved=styleOf(document);expect(saved.profiles).toEqual([]);expect(saved.stylesheet.hideDynamics).toBe(false);expect(document.profiles).toHaveLength(1);
  const target=defaultEngraving();target.profiles=[{trackId:'b',profile:'numbered'}];
  const applied=styleApplied(style(),target);expect(applied.profiles).toEqual([{trackId:'b',profile:'numbered'}]);expect(applied.stylesheet.hideDynamics).toBe(true);expect(applied.systemSpacing).toBe(1.5);
  applied.profiles[0].trackId='changed';expect(target.profiles[0].trackId).toBe('b');
  expect(defaultStyle()).toEqual(defaultEngraving());
});
it('uses exactly the typed native commands and payloads',async()=>{
  const stored=library([entry()]);invoke.mockResolvedValueOnce(library()).mockResolvedValueOnce(stored).mockResolvedValueOnce(library());
  expect(await readStyleLibrary()).toEqual(library());expect(await putStyleLibraryEntry(entry({name:' Clean '}))).toEqual(stored);expect(await removeStyleLibraryEntry(id)).toEqual(library());
  expect(invoke.mock.calls).toEqual([['style_library_read'],['style_library_put',{entry:entry()}],['style_library_remove',{id}]]);
});
it('rejects invalid entries and ids before any native call',async()=>{
  const spaced=style();spaced.systemSpacing=9;const profiled=style();profiled.profiles=[{trackId:'a',profile:'slash'}];const odd=style();(odd.stylesheet as {brackets:string}).brackets='wide';
  for(const change of [{name:''},{name:'x'.repeat(81)},{name:'\u0001bad'},{id:'../x'},{extra:1},{engraving:spaced},{engraving:profiled},{engraving:odd},{engraving:{...style(),extra:1}}]){
    await expect(putStyleLibraryEntry({...entry(),...change} as SavedStyle)).rejects.toThrow();
  }
  await expect(removeStyleLibraryEntry('nope')).rejects.toThrow();expect(invoke).not.toHaveBeenCalled();
});
it('keeps_typography_in_a_style_and_validates_it_before_any_native_call',async()=>{
  const typography={family:'mono' as const,textScale:.5,titleScale:2,tabScale:null};
  const document=defaultEngraving();document.typography=typography;document.profiles=[{trackId:'a',profile:'slash'}];
  const saved=styleOf(document);expect(saved.typography).toEqual(typography);expect(saved.profiles).toEqual([]);
  const applied=styleApplied(saved,defaultEngraving());expect(applied.typography).toEqual(typography);applied.typography!.family='sans';expect(saved.typography!.family).toBe('mono');
  expect(styleApplied(defaultStyle(),document).typography).toBeUndefined();expect('typography' in defaultStyle()).toBe(false);
  invoke.mockResolvedValueOnce(library([entry({engraving:saved})]));
  await putStyleLibraryEntry(entry({engraving:saved}));expect(invoke).toHaveBeenCalledWith('style_library_put',{entry:entry({engraving:saved})});
  invoke.mockReset();
  for(const bad of [{...typography,textScale:3},{...typography,tabScale:.5},{...typography,family:'comic'},{family:'mono'},{...typography,extra:1}]){
    await expect(putStyleLibraryEntry(entry({engraving:{...style(),typography:bad as never}}))).rejects.toThrow();
  }
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce(library([entry({engraving:{...style(),typography:{...typography,textScale:3}}})]));await expect(readStyleLibrary()).rejects.toThrow();
});
it('rejects a damaged reply and publishes only successes',async()=>{
  const seen:StyleLibrary[]=[],stop=subscribeStyleLibrary(value=>seen.push(value));
  invoke.mockResolvedValueOnce({format:'tabplayer-style-library',version:2,entries:[]});await expect(readStyleLibrary()).rejects.toThrow();
  invoke.mockResolvedValueOnce(library([entry(),entry()]));await expect(readStyleLibrary()).rejects.toThrow();
  invoke.mockRejectedValueOnce('Invalid style library: broken');await expect(readStyleLibrary()).rejects.toBeTruthy();expect(seen).toEqual([]);
  invoke.mockResolvedValueOnce(library([entry()]));const result=await readStyleLibrary();expect(seen).toEqual([result]);stop();
});
it('names follow the same rules as the native store',()=>{
  expect(styleNameError('Öine 🎸')).toBeNull();
  for(const bad of ['',' ',' pad','pad ','﻿x','x\u0085','x'.repeat(81),'a\u0001b'])expect(styleNameError(bad)).not.toBeNull();
  expect(styleNameError('🎸'.repeat(80))).toBeNull();
});
it('client_accepts_only_version_3',async()=>{
  for(const version of [0,1,2,4]){
    invoke.mockResolvedValueOnce({format:'tabplayer-style-library',version,entries:[]});
    await expect(readStyleLibrary()).rejects.toThrow('Unsupported');
  }
  invoke.mockResolvedValueOnce(library());await expect(readStyleLibrary()).resolves.toEqual(library());
});
it('style_of_keeps_fonts_and_applied_style_replaces_them',async()=>{
  const document=defaultEngraving();document.fonts={music:'petaluma',roles:{lyrics:{font:'notoSerif'}}};document.profiles=[{trackId:'a',profile:'slash'}];
  const saved=styleOf(document);expect(saved.fonts).toEqual(document.fonts);expect(saved.fonts).not.toBe(document.fonts);
  const target=defaultEngraving();target.fonts={roles:{markers:{bold:true}}};
  expect(styleApplied(saved,target).fonts).toEqual(document.fonts);
  expect(styleApplied(defaultStyle(),target).fonts).toBeUndefined();
  invoke.mockResolvedValueOnce(library([entry({engraving:saved})]));
  await putStyleLibraryEntry(entry({engraving:saved}));expect(invoke).toHaveBeenCalledWith('style_library_put',{entry:entry({engraving:saved})});
  invoke.mockResolvedValueOnce(library([entry({engraving:saved})]));
  expect((await readStyleLibrary()).entries[0].engraving.fonts).toEqual(document.fonts);
  const bad=style();bad.fonts={roles:{lyrics:{font:'comic'}}} as never;
  await expect(putStyleLibraryEntry(entry({engraving:bad}))).rejects.toThrow();
});
