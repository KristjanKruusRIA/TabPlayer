// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {model} from '@coderline/alphatab';
import {SoundPanel,soundPreset} from './SoundPanel';
import {applySettingsEdit,defaultDocumentSettings,defaultEffects} from '../document-settings';
import type {TrackSound} from '../edit-types';
afterEach(cleanup);

it('defaults match the native blocks and are off',()=>{
  const fx=defaultEffects();
  expect({vibrato:fx.vibrato,phaser:fx.phaser,flanger:fx.flanger,tremolo:fx.tremolo}).toEqual({
    vibrato:{enabled:false,rateHz:5,depthCents:20},
    phaser:{enabled:false,rateHz:.5,depth:.7,feedback:.3,stages:4,mix:.5},
    flanger:{enabled:false,rateHz:.25,depthMs:2,feedback:.5,mix:.5},
    tremolo:{enabled:false,rateHz:5,depth:.5,shape:'sine'},
  });
});

/** A sound saved before the modulation blocks existed. */
function olderSound():TrackSound {
  const sound=soundPreset('crunch') as unknown as {effects:Record<string,unknown>};
  for(const block of ['vibrato','phaser','flanger','tremolo'])delete sound.effects[block];
  return sound as unknown as TrackSound;
}

it('fills the new blocks into sounds saved before them',()=>{
  const settings=defaultDocumentSettings();
  applySettingsEdit(settings,{type:'setTrackSound',trackId:'base/0',sound:olderSound()},new model.Score(),['base/0']);
  const stored=settings.sounds['base/0'];
  expect(stored.effects.flanger).toEqual(defaultEffects().flanger);
  expect(stored.effects.tremolo.shape).toBe('sine');
  expect(stored.effects.amp).toEqual(soundPreset('crunch').effects.amp);
  // The panel also opens such a sound and edits its new blocks.
  const onEdit=vi.fn();render(<SoundPanel trackId="base/0" sound={olderSound()} onEdit={onEdit}/>);
  fireEvent.click(screen.getByLabelText('Enable flanger'));
  expect(onEdit.mock.calls.at(-1)?.[0].sound.effects).toMatchObject({flanger:{enabled:true},amp:{model:'crunch'}});
});

it('refuses invalid shapes and stages',()=>{
  const settings=defaultDocumentSettings(),sound=soundPreset('gm');
  const bad=(patch:(effects:TrackSound['effects'])=>void)=>{const next=structuredClone(sound);patch(next.effects);return ()=>applySettingsEdit(settings,{type:'setTrackSound',trackId:'base/0',sound:next},new model.Score(),['base/0']);};
  expect(bad(fx=>{(fx.tremolo as {shape:string}).shape='triangle';})).toThrow('Invalid effect parameter.');
  expect(bad(fx=>{fx.phaser.stages=3 as never;})).toThrow('Invalid effect parameter.');
});

it('lists the modulation blocks in signal order with their controls',()=>{
  const onEdit=vi.fn();const {container}=render(<SoundPanel trackId="base/0" sound={soundPreset('gm')} onEdit={onEdit}/>);
  expect([...container.querySelectorAll('.sound-block-name')].map(node=>node.textContent)).toEqual(['Gate','Compressor','Wah','Amp','Cabinet','EQ','Vibrato','Phaser','Flanger','Chorus','Tremolo','Delay','Reverb']);
  for(const [label,value] of [['vibrato Depth (cents)','60'],['phaser Rate (Hz)','1.5'],['flanger Feedback','-0.4'],['tremolo Depth','0.8']] as const){
    fireEvent.change(screen.getByLabelText(label),{target:{value}});
  }
  const last=()=>onEdit.mock.calls.at(-1)?.[0].sound.effects;
  expect(last().tremolo.depth).toBe(.8);
  expect(onEdit.mock.calls.map(call=>call[0].sound.effects).find(fx=>fx.flanger.feedback===-.4)).toBeTruthy();
  const tremolo=container.querySelectorAll('.sound-block')[10] as HTMLElement;
  fireEvent.change(within(tremolo).getByLabelText('Tremolo shape'),{target:{value:'square'}});expect(last().tremolo.shape).toBe('square');
  fireEvent.change(screen.getByLabelText('Phaser stages'),{target:{value:'8'}});expect(last().phaser.stages).toBe(8);
  expect(screen.getByLabelText('flanger Feedback')).toHaveAttribute('min','-0.9');
  expect(screen.getByLabelText('vibrato Depth (cents)')).toHaveAttribute('max','100');
});
