// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {model} from '@coderline/alphatab';
import {SoundPanel,soundPreset} from './SoundPanel';
import {applySettingsEdit,defaultDocumentSettings,defaultEffects,soundProblem} from '../document-settings';
import {forgetSoundClipboard,readSoundLibrary,saveSoundPreset} from './sound-library';
import type {TrackSound} from '../edit-types';
afterEach(()=>{cleanup();localStorage.clear();});
const blocks=[['chorus','Chorus'],['flanger','Flanger'],['phaser','Phaser'],['tremolo','Tremolo'],['vibrato','Vibrato']] as const;
type Synced=Record<string,{syncQuarterNotes?:unknown}>;
/** A sound with `block` synced to `sync` quarter notes per cycle. */
const synced=(block:string,sync:unknown)=>{const sound=soundPreset('gm');(sound.effects as unknown as Synced)[block].syncQuarterNotes=sync;return sound;};

it('keeps the free rate by default, so sounds saved before tempo sync play as they did',()=>{
  for(const [block] of blocks)expect(Object.hasOwn((defaultEffects() as unknown as Synced)[block],'syncQuarterNotes')).toBe(false);
  expect(soundProblem(soundPreset('lead'))).toBeNull();
});

it('accepts the note durations the native player follows and refuses others',()=>{
  for(const [block] of blocks){
    for(const sync of [0,.125,.25,1/3,.5,2/3,.75,1,1.5,2,4,8,16])expect(soundProblem(synced(block,sync)),`${block} ${sync}`).toBeNull();
    for(const sync of [.3,-1,Number.NaN,32,'1',null])expect(soundProblem(synced(block,sync)),`${block} ${String(sync)}`).toBe('Invalid effect parameter.');
  }
  // Other blocks do not take a sync.
  expect(soundProblem(synced('delay',1))).toBe('Invalid effect parameter.');
  const settings=defaultDocumentSettings();
  applySettingsEdit(settings,{type:'setTrackSound',trackId:'base/0',sound:synced('tremolo',.5)},new model.Score(),['base/0']);
  expect(settings.sounds['base/0'].effects.tremolo.syncQuarterNotes).toBe(.5);
});

it('offers each modulation block a tempo sync that replaces its free rate',()=>{
  const onEdit=vi.fn();
  const {rerender}=render(<SoundPanel trackId="base/0" sound={soundPreset('gm')} onEdit={onEdit}/>);
  for(const [block,name] of blocks){
    const select=screen.getByLabelText(`${name} tempo sync`),rate=screen.getByLabelText(`${block} Rate (Hz)`);
    expect([...select.querySelectorAll('option')].map(option=>option.textContent)).toEqual(['Off (free rate)','1/32','1/16','1/8 triplet','1/8','1/4 triplet','Dotted 1/8','1/4','Dotted 1/4','1/2','Whole','2 whole notes','4 whole notes']);
    expect(select).toHaveValue('0');expect(rate).toBeEnabled();
    fireEvent.change(select,{target:{value:'0.75'}});
    const sound:TrackSound=onEdit.mock.calls.at(-1)?.[0].sound;
    expect((sound.effects as unknown as Synced)[block].syncQuarterNotes).toBe(.75);
    // The rest of the block is untouched.
    expect({...(sound.effects as unknown as Synced)[block],syncQuarterNotes:undefined}).toEqual({...(defaultEffects() as unknown as Synced)[block],syncQuarterNotes:undefined});
    rerender(<SoundPanel trackId="base/0" sound={sound} onEdit={onEdit}/>);
    expect(screen.getByLabelText(`${name} tempo sync`)).toHaveValue('0.75');
    expect(screen.getByLabelText(`${block} Rate (Hz)`)).toBeDisabled();
    // Off goes back to the free rate, which writes no sync.
    fireEvent.change(screen.getByLabelText(`${name} tempo sync`),{target:{value:'0'}});
    const free:TrackSound=onEdit.mock.calls.at(-1)?.[0].sound;
    expect(Object.hasOwn((free.effects as unknown as Synced)[block],'syncQuarterNotes')).toBe(false);
    rerender(<SoundPanel trackId="base/0" sound={free} onEdit={onEdit}/>);
    expect(screen.getByLabelText(`${block} Rate (Hz)`)).toBeEnabled();
  }
});

it('keeps a tempo sync in saved sounds',()=>{
  const sound=synced('phaser',8);
  expect(saveSoundPreset('Slow sweep',sound).ok).toBe(true);
  expect(readSoundLibrary()[0].sound.effects.phaser.syncQuarterNotes).toBe(8);
});

it('copies and pastes a pedal with its tempo sync, and a free pedal pasted over a synced one is free',()=>{
  forgetSoundClipboard();
  const onEdit=vi.fn();
  const {unmount}=render(<SoundPanel trackId="base/0" sound={synced('chorus',1.5)} onEdit={onEdit}/>);
  fireEvent.click(screen.getByLabelText('Copy pedal: Chorus'));unmount();
  render(<SoundPanel trackId="base/1" sound={soundPreset('gm')} onEdit={onEdit}/>);
  fireEvent.click(screen.getByLabelText('Paste pedal: Chorus'));
  expect(onEdit.mock.calls.at(-1)?.[0].sound.effects.chorus.syncQuarterNotes).toBe(1.5);
  cleanup();
  render(<SoundPanel trackId="base/0" sound={soundPreset('gm')} onEdit={onEdit}/>);
  fireEvent.click(screen.getByLabelText('Copy pedal: Chorus'));cleanup();
  render(<SoundPanel trackId="base/1" sound={synced('chorus',1.5)} onEdit={onEdit}/>);
  fireEvent.click(screen.getByLabelText('Paste pedal: Chorus'));
  expect(Object.hasOwn(onEdit.mock.calls.at(-1)?.[0].sound.effects.chorus,'syncQuarterNotes')).toBe(false);
});
