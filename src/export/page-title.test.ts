import {afterEach,describe,expect,it,vi} from 'vitest';
import {paginateSystems} from './pdf';
import {paginateEngravedSystems} from '../engraving/page';

const title='Öölaul — 同じ楽譜 🎸 · A very long independently authored document title for horizontal score tab overflow';
const width=180*96/25.4;
const system={width:680,height:100,svg:'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 10"/></svg>'};
const print={paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'ScoreTab' as const};
const page={widthMm:210,heightMm:297,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1,profile:'document' as const};
const renderers=[
  ['legacy',(text:string)=>paginateSystems([system],text,print)],
  ['document',(text:string)=>paginateEngravedSystems([system],text,page)],
] as const;
afterEach(()=>vi.unstubAllGlobals());

describe.each(renderers)('%s printed title',(_name,render)=>{
  it('fits the full Unicode title within printable width without moving notation',()=>{
    const context={font:'',measureText:vi.fn(()=>({width:900}))};
    vi.stubGlobal('document',{createElement:()=>({getContext:()=>context})});
    const svg=new DOMParser().parseFromString(render(title)[0].svg,'image/svg+xml');
    const header=svg.querySelector('text')!;
    expect(header.textContent).toBe(title);
    expect(Number(header.getAttribute('font-size'))/18*900).toBeLessThanOrEqual(width);
    expect(Number(header.getAttribute('font-size'))).toBeGreaterThan(13);
    expect(context.font).toContain('Noto Sans CJK JP');expect(context.font).toContain('Noto Emoji');
    expect(context.measureText).toHaveBeenCalledWith(title);
    expect(svg.querySelector('g')?.getAttribute('transform')).toBe(`translate(${15*96/25.4} ${15*96/25.4+40})`);
  });
  it('keeps a short title at its established size and preserves escaped text',()=>{
    vi.stubGlobal('document',{createElement:()=>({getContext:()=>({font:'',measureText:()=>({width:100})})})});
    const svg=new DOMParser().parseFromString(render('A&B <solo>')[0].svg,'image/svg+xml');
    const header=svg.querySelector('text')!;
    expect(header.textContent).toBe('A&B <solo>');expect(header.getAttribute('font-size')).toBe('18');
  });
});
