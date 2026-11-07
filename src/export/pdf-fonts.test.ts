// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const made:Array<{load:ReturnType<typeof vi.fn>}>=[],added:unknown[]=[];
let failNext=false;
beforeEach(()=>{
  vi.resetModules();made.length=0;added.length=0;
  vi.stubGlobal('FontFace',class {load=vi.fn(()=>failNext?Promise.reject(new Error('load failed')):Promise.resolve(this));constructor(){made.push(this);}});
  Object.defineProperty(document,'fonts',{configurable:true,value:{add:(face:unknown)=>added.push(face)}});
});
afterEach(()=>{vi.unstubAllGlobals();failNext=false;});
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
