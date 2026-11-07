// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const made:Array<{load:ReturnType<typeof vi.fn>}>=[],added:unknown[]=[];
let failNext=false,failOnly=-1;
beforeEach(()=>{
  vi.resetModules();made.length=0;added.length=0;
  vi.stubGlobal('FontFace',class {load=vi.fn(():Promise<unknown>=>failNext||made.indexOf(this)===failOnly?Promise.reject(new Error('load failed')):Promise.resolve(this));constructor(){made.push(this);}});
  Object.defineProperty(document,'fonts',{configurable:true,value:{add:(face:unknown)=>added.push(face)}});
});
afterEach(()=>{vi.unstubAllGlobals();failNext=false;failOnly=-1;});
it('constructs the fonts once across calls',async()=>{
  const {loadExportFonts}=await import('./pdf');
  await Promise.all([loadExportFonts(),loadExportFonts()]);await loadExportFonts();
  expect(made).toHaveLength(4);expect(added).toHaveLength(4);
});
it('adds nothing on a failed load and retries with new faces',async()=>{
  const {loadExportFonts}=await import('./pdf');
  failNext=true;await expect(loadExportFonts()).rejects.toThrow('load failed');
  expect(added).toHaveLength(0);expect(made).toHaveLength(4);
  failNext=false;await loadExportFonts();
  expect(made).toHaveLength(8);expect(added).toHaveLength(4);
});
it('adds no face when only one of them fails to load',async()=>{
  const {loadExportFonts}=await import('./pdf');
  failOnly=2;await expect(loadExportFonts()).rejects.toThrow('load failed');
  expect(made).toHaveLength(4);expect(added).toHaveLength(0);
});
it('resolves without loading anything where FontFace is missing',async()=>{
  vi.stubGlobal('FontFace',undefined);
  const {loadExportFonts}=await import('./pdf');
  await expect(loadExportFonts()).resolves.toBeUndefined();
  expect(made).toHaveLength(0);expect(added).toHaveLength(0);
});
