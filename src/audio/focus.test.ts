import { describe,expect,it } from 'vitest';
import { defaultDocumentSettings } from '../document-settings';
import { focusedSettings } from './focus';

const settings=()=>{const value=defaultDocumentSettings();value.mixes={a:{gain:.8,pan:.5,mute:false,solo:false}};value.backing={assetId:'x'.repeat(64),offsetMs:0,anchors:[],mix:{gain:.6,pan:0,mute:false,solo:false}};return value;};

describe('track focus',()=>{
  it('lowers every other track and the backing when focusing, without touching the saved settings',()=>{
    const saved=settings(),before=structuredClone(saved),focused=focusedSettings(saved,['a','b'],{track:'a',amount:.75});
    expect(focused.mixes).toEqual({a:{gain:.8,pan:.5,mute:false,solo:false},b:{gain:.25,pan:0,mute:false,solo:false}});
    expect(focused.backing?.mix.gain).toBeCloseTo(.15);expect(saved).toEqual(before);
  });
  it('lowers only the focused track when unfocusing',()=>{
    const focused=focusedSettings(settings(),['a','b'],{track:'a',amount:-.5});
    expect(focused.mixes).toEqual({a:{gain:.4,pan:.5,mute:false,solo:false},b:{gain:1,pan:0,mute:false,solo:false}});expect(focused.backing?.mix.gain).toBe(.6);
  });
  it('leaves settings alone without focus, at zero, or for a track that no longer exists, and refuses invalid amounts',()=>{
    const saved=settings();
    for(const focus of [null,{track:'a',amount:0},{track:'gone',amount:1}])expect(focusedSettings(saved,['a','b'],focus)).toBe(saved);
    for(const amount of [1.5,-2,Number.NaN])expect(()=>focusedSettings(saved,['a'],{track:'a',amount})).toThrow('Focus must be between -100% and 100%.');
  });
});
