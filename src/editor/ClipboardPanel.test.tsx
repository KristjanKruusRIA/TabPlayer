// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model,Settings } from '@coderline/alphatab';
import { ClipboardPanel } from './ClipboardPanel';
import { makeMusicClip } from './clipboard-source';
import type { ClipboardMode,MusicClip,PasteOptions } from './clipboard-types';
import type { MusicSelection } from './range-types';
import { music,target } from './fixtures';

afterEach(cleanup);
const bars:MusicSelection={kind:'bars',tracks:[0],firstBar:0,lastBar:0};
const phrase=()=>makeMusicClip(music(),{kind:'notes',notes:[{target,noteIndex:0}]},'singleTrack');
const barClip=(mode:ClipboardMode='singleTrack',lastBar=0)=>makeMusicClip(music(),{kind:'bars',tracks:[0],firstBar:0,lastBar},mode);
const filters={diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false};
const change=(label:string,value:string)=>fireEvent.change(screen.getByLabelText(label),{target:{value}});
const paste=()=>fireEvent.click(screen.getByRole('button',{name:'Paste music'}));
const trackLabel=(track:number)=>`Destination track for copied track ${track}`;
const staffLabel=(track:number,staff:number)=>`Destination staff for copied track ${track}, staff ${staff}`;
function destination(tracks=3,staves=2) {
  const score=music();for(let index=1;index<tracks;index++){const track=music().tracks[0];track.name=`Track ${index+1}`;score.addTrack(track);}
  for(const track of score.tracks)for(let index=1;index<staves;index++)track.addStaff(music().tracks[0].staves[0]);score.finish(new Settings());return score;
}
it('copy_cut_modes_report_expanded_scope_and_global_multitrack_removal',()=>{
  const calls:{kind:string;mode:ClipboardMode}[]=[],selection:MusicSelection={kind:'notes',notes:[{target:{...target,bar:1,beat:2},noteIndex:0}]};
  render(<ClipboardPanel score={music()} target={target} selection={selection} clip={null} busy={false} onCopy={mode=>calls.push({kind:'copy',mode})} onCut={mode=>calls.push({kind:'cut',mode})} onPaste={()=>{}}/>);
  expect(screen.queryByRole('button',{name:'Copy music'})).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Copy music'}));fireEvent.click(screen.getByRole('button',{name:'Cut music'}));
  change('Copy/cut mode','multiTrack');expect(screen.getByText(/Measures 2–2/)).toBeInTheDocument();expect(screen.getByText(/Cut removes these measures from every track/)).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Copy music'}));fireEvent.click(screen.getByRole('button',{name:'Cut music'}));
  expect(calls).toEqual([{kind:'copy',mode:'singleTrack'},{kind:'cut',mode:'singleTrack'},{kind:'copy',mode:'multiTrack'},{kind:'cut',mode:'multiTrack'}]);
});
it('phrase_and_bar_defaults_emit_detached_options_and_never_display_raw_music',()=>{
  const score=music(),source=music();source.tracks[0].staves[0].bars[0].voices[0].beats[0].text='PRIVATE_NOTE_SENTINEL';const clip=makeMusicClip(source,{kind:'notes',notes:[{target,noteIndex:0}]},'singleTrack');
  const options:PasteOptions[]=[],props={score,target,selection:bars,clip,busy:false,onCopy:()=>{},onCut:()=>{},onPaste:(value:PasteOptions)=>options.push(value)},view=render(<ClipboardPanel {...props}/>);
  expect(screen.getByText(/Phrase.*current beat/i)).toBeInTheDocument();expect(screen.queryByText(/PRIVATE_NOTE_SENTINEL/)).not.toBeInTheDocument();expect(screen.queryByText(/TabPlayerClip/)).not.toBeInTheDocument();
  for(const name of ['Master tempo automations','Sections']){expect(screen.getByLabelText(name)).toBeDisabled();expect(screen.getByLabelText(name)).not.toBeChecked();}
  paste();expect(options).toEqual([{target:{track:0,staff:0,bar:0,voice:0,beat:0},destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'currentBar',filters}]);
  expect(options[0].target).not.toBe(target);change('Paste repetitions','3');expect(options[0].count).toBe(1);
  view.rerender(<ClipboardPanel {...props} target={{...target,bar:1}} clip={barClip()}/>);expect(screen.getByText(/Complete bars.*before measure 2/i)).toBeInTheDocument();paste();expect(options[1]).toEqual({target:{track:0,staff:0,bar:1,voice:0,beat:0},destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'beforeBar',filters});
});
it('multitrack_defaults_and_explicit_unique_track_staff_mappings_are_exact',()=>{
  const source=destination(2,2),clip=makeMusicClip(source,{kind:'bars',tracks:[0,1],firstBar:0,lastBar:0},'multiTrack'),options:PasteOptions[]=[];
  render(<ClipboardPanel score={destination()} target={target} selection={bars} clip={clip} busy={false} onCopy={()=>{}} onCut={()=>{}} onPaste={value=>options.push(value)}/>);
  expect(screen.getByLabelText(trackLabel(1))).toHaveValue('0');expect(screen.getByLabelText(trackLabel(2))).toHaveValue('1');for(const label of ['Chord diagrams','Beat texts','Timers','Track automations','Master tempo automations','Sections'])expect(screen.getByLabelText(label)).toBeChecked();
  change(trackLabel(1),'1');paste();expect(options).toEqual([]);expect(screen.getByRole('alert')).toHaveTextContent(/unique.*track/i);
  change(trackLabel(1),'2');change(staffLabel(1,1),'1');paste();expect(options).toEqual([]);expect(screen.getByRole('alert')).toHaveTextContent(/unique.*sta(f|v)/i);
  change(staffLabel(1,2),'0');change('Paste repetitions','2');paste();
  expect(options).toEqual([{target:{track:0,staff:0,bar:0,voice:0,beat:0},destinations:[{sourceTrack:0,track:2,staffMap:[1,0]},{sourceTrack:1,track:1,staffMap:[0,1]}],count:2,placement:'beforeBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:true,sections:true}}]);
  change(staffLabel(1,1),'0');expect(options[0].destinations[0].staffMap).toEqual([1,0]);
});
it('all_six_filters_are_explicit_and_bar_expansion_stays_within_1000',()=>{
  const options:PasteOptions[]=[];render(<ClipboardPanel score={music()} target={target} selection={bars} clip={barClip('multiTrack',1)} busy={false} onCopy={()=>{}} onCut={()=>{}} onPaste={value=>options.push(value)}/>);
  for(const label of ['Chord diagrams','Beat texts','Timers','Track automations','Master tempo automations','Sections'])fireEvent.click(screen.getByLabelText(label));change('Paste repetitions','1000');paste();expect(options).toEqual([]);expect(screen.getByRole('alert')).toHaveTextContent(/1000.*measure/i);
  change('Paste repetitions','500');paste();expect(options).toEqual([{target:{track:0,staff:0,bar:0,voice:0,beat:0},destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:500,placement:'beforeBar',filters:{diagrams:false,texts:false,timers:false,trackAutomations:false,masterAutomations:false,sections:false}}]);
});
it('invalid_counts_and_missing_existing_tracks_staves_or_voices_never_dispatch',()=>{
  const options:PasteOptions[]=[],props={score:music(),target,selection:bars,clip:phrase(),busy:false,onCopy:()=>{},onCut:()=>{},onPaste:(value:PasteOptions)=>options.push(value)},view=render(<ClipboardPanel {...props}/>);
  for(const value of ['','0','1001','1.5']){change('Paste repetitions',value);paste();expect(screen.getByRole('alert')).toHaveTextContent(/1.*1000/i);}
  const source=destination(2,2),clip=makeMusicClip(source,{kind:'bars',tracks:[0,1],firstBar:0,lastBar:0},'multiTrack');view.rerender(<ClipboardPanel {...props} clip={clip}/>);paste();expect(screen.getByRole('alert')).toHaveTextContent(/existing.*track|map every.*track/i);
  view.rerender(<ClipboardPanel {...props} score={destination(2,1)} clip={clip}/>);paste();expect(screen.getByRole('alert')).toHaveTextContent(/existing.*staff|map every.*staff/i);
  const voices=music();for(const bar of voices.tracks[0].staves[0].bars){const voice=new model.Voice(),rest=new model.Beat();rest.duration=1;rest.isEmpty=false;voice.addBeat(rest);bar.addVoice(voice);}voices.finish(new Settings());view.rerender(<ClipboardPanel {...props} clip={makeMusicClip(voices,bars,'singleTrack')}/>);paste();expect(screen.getByRole('alert')).toHaveTextContent(/every copied voice/i);expect(options).toEqual([]);
});
it('a_phrase_maps_to_the_selected_staff_and_voice',()=>{
  const options:PasteOptions[]=[],selected={...target,track:1,staff:1};render(<ClipboardPanel score={destination()} target={selected} selection={null} clip={phrase()} busy={false} onCopy={()=>{}} onCut={()=>{}} onPaste={value=>options.push(value)}/>);
  expect(screen.getByLabelText(trackLabel(1))).toHaveValue('1');expect(screen.getByLabelText(staffLabel(1,1))).toHaveValue('1');paste();expect(options[0].destinations).toEqual([{sourceTrack:0,track:1,staffMap:[1]}]);expect(options[0].target).toEqual({track:1,staff:1,bar:0,voice:0,beat:0});
});
it('busy_or_missing_selection_blocks_actions_and_unchanged_rerenders_preserve_the_draft',()=>{
  const calls:string[]=[],score=music(),clip=phrase(),props={score,target,selection:bars,clip,busy:false,onCopy:()=>calls.push('copy'),onCut:()=>calls.push('cut'),onPaste:()=>calls.push('paste')},view=render(<ClipboardPanel {...props}/>);
  change('Paste repetitions','3');view.rerender(<ClipboardPanel {...props} busy/>);expect(screen.getByLabelText('Paste repetitions')).toHaveValue(3);for(const name of ['Copy music','Cut music','Paste music']){expect(screen.getByRole('button',{name})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name}));}expect(calls).toEqual([]);
  view.rerender(<ClipboardPanel {...props} selection={null}/>);expect(screen.getByRole('button',{name:'Copy music'})).toBeDisabled();expect(screen.getByRole('button',{name:'Cut music'})).toBeDisabled();expect(screen.getByRole('button',{name:'Paste music'})).toBeEnabled();
});
it('callback_failures_are_inline_and_invalid_clip_errors_do_not_echo_payloads',()=>{
  const props={score:music(),target,selection:bars,clip:phrase(),busy:false,onCopy:()=>{throw new Error('Copy failed.');},onCut:()=>{throw new Error('Cut failed.');},onPaste:()=>{throw new Error('Paste failed.');}},view=render(<ClipboardPanel {...props}/>);
  for(const [name,message]of [['Copy music','Copy failed.'],['Cut music','Cut failed.'],['Paste music','Paste failed.']]){fireEvent.click(screen.getByRole('button',{name}));expect(screen.getByRole('alert')).toHaveTextContent(message);}
  view.rerender(<ClipboardPanel {...props} clip={{...phrase(),scoreJson:'{"SECRET_PAYLOAD_SENTINEL"'} as MusicClip}/>);expect(screen.getByRole('button',{name:'Paste music'})).toBeDisabled();expect(screen.getByRole('alert')).toHaveTextContent(/invalid or unsupported/i);expect(screen.queryByText(/SECRET_PAYLOAD_SENTINEL/)).not.toBeInTheDocument();
});
it('paste_validation_and_failures_remain_visible_with_an_unsupported_copy_scope',()=>{
  const selection:MusicSelection={kind:'bars',tracks:[0,1],firstBar:0,lastBar:0};render(<ClipboardPanel score={destination()} target={target} selection={selection} clip={phrase()} busy={false} onCopy={()=>{}} onCut={()=>{}} onPaste={()=>{throw new Error('Paste candidate rejected.');}}/>);
  expect(screen.getByRole('button',{name:'Copy music'})).toBeDisabled();change('Paste repetitions','');paste();expect(screen.getByRole('alert')).toHaveTextContent(/1.*1000/i);change('Paste repetitions','1');paste();expect(screen.getByRole('alert')).toHaveTextContent('Paste candidate rejected.');
});
