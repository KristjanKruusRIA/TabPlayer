import { afterEach,describe,expect,it } from 'vitest';
import { automaticPanelSizes,forgetSessionPanelSizes,readPanelSizes,writePanelSizes } from './panel-sizes';

const memory=(initial?:string)=>{const values=new Map<string,string>();if(initial!==undefined)values.set('tabplayer.panelSizes',initial);return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},values};};
afterEach(forgetSessionPanelSizes);

describe('panel sizes',()=>{
  it('reads automatic sizes when nothing or something unreadable is stored',()=>{
    expect(readPanelSizes(memory())).toEqual(automaticPanelSizes);
    expect(readPanelSizes(memory('not json'))).toEqual(automaticPanelSizes);
    expect(readPanelSizes(memory('[1,2]'))).toEqual(automaticPanelSizes);
    expect(readPanelSizes(undefined)).toEqual(automaticPanelSizes);
  });
  it('keeps each valid size and reads the rest as automatic',()=>{
    expect(readPanelSizes(memory(JSON.stringify({inspector:351.6,dock:'tall'})))).toEqual({inspector:352,dock:null});
    expect(readPanelSizes(memory(JSON.stringify({inspector:-5,dock:1e9})))).toEqual({inspector:null,dock:null});
    expect(readPanelSizes(memory(JSON.stringify({inspector:null,dock:200})))).toEqual({inspector:null,dock:200});
  });
  it('writes the sizes and reads them back in a later run',()=>{
    const storage=memory();
    expect(writePanelSizes({inspector:400,dock:240},storage)).toBe(true);
    forgetSessionPanelSizes();
    expect(readPanelSizes(storage)).toEqual({inspector:400,dock:240});
  });
  it('keeps the sizes for this run when storage refuses them',()=>{
    const refusing={getItem:()=>null,setItem:()=>{throw new Error('Quota exceeded');}};
    expect(writePanelSizes({inspector:420,dock:null},refusing)).toBe(false);
    expect(readPanelSizes(refusing)).toEqual({inspector:420,dock:null});
  });
});
