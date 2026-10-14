// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Transport } from './Transport';
afterEach(cleanup);
it('uses structural native transport controls and validates measure drafts',()=>{
  const state={ready:true,playing:false,time:1000,endTime:6000,measure:0,speed:100,metronome:false,error:null};
  const player={getState:()=>state,subscribe:()=>()=>{},play:vi.fn(),pause:vi.fn(),stop:vi.fn(),setSpeed:vi.fn(),setLoop:vi.fn(),clearLoop:vi.fn(),seekToMeasure:vi.fn(),setMetronome:vi.fn()};
  const view=render(<Transport player={player} measures={4} busy={false}/>);fireEvent.change(screen.getByLabelText('Seek measure'),{target:{value:'1.5'}});fireEvent.click(screen.getByRole('button',{name:'Seek'}));expect(player.seekToMeasure).toHaveBeenLastCalledWith(0);
  fireEvent.change(screen.getByLabelText('Seek measure'),{target:{value:'4'}});fireEvent.click(screen.getByRole('button',{name:'Seek'}));expect(player.seekToMeasure).toHaveBeenLastCalledWith(3);
  fireEvent.click(screen.getByRole('button',{name:'Play'}));expect(player.play).toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Loop'}));expect(player.setLoop).toHaveBeenCalledWith(0,0);fireEvent.click(screen.getByRole('button',{name:'Clear loop'}));expect(player.clearLoop).toHaveBeenCalled();
  view.rerender(<Transport player={player} measures={2} busy={false}/>);expect(screen.getByLabelText('Seek measure')).toHaveValue(2);view.rerender(<Transport player={player} measures={2} busy/>);expect(screen.getByRole('button',{name:'Play'})).toBeDisabled();
});
