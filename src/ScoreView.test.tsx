// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { model } from '@coderline/alphatab';
import { ScoreView } from './ScoreView';
import { music, target } from './editor/fixtures';

const view=vi.hoisted(()=>({options:null as unknown,beat:null as ((beat:model.Beat)=>void)|null,note:null as ((note:model.Note)=>void)|null,destroy:vi.fn(),settings:vi.fn()}));
vi.mock('@coderline/alphatab',async original=>({...await original<typeof import('@coderline/alphatab')>(),AlphaTabApi:class {
  settings={display:{scale:1,staveProfile:0}};constructor(_container:unknown,options:unknown){view.options=options;}
  beatMouseDown={on:(handler:(beat:model.Beat)=>void)=>{view.beat=handler;}};noteMouseDown={on:(handler:(note:model.Note)=>void)=>{view.note=handler;}};
  destroy=view.destroy;updateSettings=view.settings;
}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('uses public external media output and keeps viewport changes out of native plan loading',()=>{
  const score=music(),playback={attachView:vi.fn(),replaceScore:vi.fn()},onSelect=vi.fn();const props={score,track:0,zoom:100,profile:'ScoreTab',onSelect,playback:playback as never};const rendered=render(<ScoreView {...props}/>);
  expect(view.options).toMatchObject({player:{playerMode:'EnabledExternalMedia',enableCursor:true}});expect((view.options as {player:object}).player).not.toHaveProperty('soundFont');expect(playback.attachView).toHaveBeenCalledTimes(1);
  view.note?.(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0]);expect(onSelect).toHaveBeenLastCalledWith(target,6);
  rendered.rerender(<ScoreView {...props} zoom={130}/>);expect(playback.replaceScore).toHaveBeenLastCalledWith(score,0);expect(playback.attachView).toHaveBeenCalledTimes(1);
  rendered.unmount();expect(view.destroy).toHaveBeenCalledTimes(1);
});
