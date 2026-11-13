import { describe, expect, it } from 'vitest';
import { AUTO_FIT_RELEASE_MARGIN_PX,wantsAutoFit } from './auto-fit';

// A page 800px wide at 100%.
const at=(available:number,fitted:boolean,zoom=100)=>wantsAutoFit({pageWidth:800,zoom,available,fitted});
describe('auto fit with hysteresis (THE-196)',()=>{
  it('releases only a clear margin past the page, which is more than a scrollbar',()=>{expect(AUTO_FIT_RELEASE_MARGIN_PX).toBeGreaterThanOrEqual(17);});
  it('starts when the page is wider than the area, and not when it just fits',()=>{
    expect(at(799,false)).toBe(true);expect(at(800,false)).toBe(false);expect(at(801,false)).toBe(false);
  });
  it('once fitted, stays fitted inside the margin on either side',()=>{
    const edge=800+AUTO_FIT_RELEASE_MARGIN_PX;
    expect(at(800,true)).toBe(true);expect(at(801,true)).toBe(true);expect(at(edge-1,true)).toBe(true);
    expect(at(edge,true)).toBe(false);expect(at(edge+200,true)).toBe(false);
  });
  it('does not change state through fitted, slightly wider, slightly narrower',()=>{
    let fitted=at(790,false);expect(fitted).toBe(true);
    for(const width of [790,805,815,805,795,790,812,799]){fitted=at(width,fitted);expect(fitted).toBe(true);}
  });
  it('does not change state through unfitted, slightly narrower than the margin, slightly wider',()=>{
    let fitted=at(810,false);expect(fitted).toBe(false);
    for(const width of [815,805,801,820,830]){fitted=at(width,fitted);expect(fitted).toBe(false);}
  });
  it('measures the page at the current zoom',()=>{expect(at(900,false,125)).toBe(true);expect(at(900,false,100)).toBe(false);});
});
