// @vitest-environment jsdom
import { afterEach,describe,expect,it,vi } from 'vitest';
import { cleanup,render,screen,fireEvent,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { ExportDialog } from './ExportDialog';
import { validateSelection } from './types';
import { soundPreset } from '../audio/SoundPanel';
import { invoke } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async(command:string,args?:{ids?:string[]})=>command==='cabinet_ir_status'?args!.ids!.map(id=>({id,state:'missing',message:null})):[])}));
afterEach(cleanup);
function fixture(){const score=new model.Score();for(let i=0;i<3;i++)score.addMasterBar(new model.MasterBar());const track=new model.Track();track.name='Lead';score.addTrack(track);return score;}
const layout={paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'ScoreTab' as const};

it('explains supported uniform common/cut interchange beside GP export options',()=>{
  render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={()=>{}} onCancel={()=>{}}/>);
  expect(screen.getByText('Engraving settings affect the screen and PDF. GP export preserves source styling and supports uniform common/cut choices; mixed measure choices cannot be exported.')).toBeVisible();
});

it('includes GP backing by default without exposing audio format settings',()=>{
  const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  expect(screen.getByLabelText('Include backing audio')).toBeChecked();
  for(const label of ['Sample rate','Bit depth','Speed','Metronome','Effect tail (seconds)'])expect(screen.queryByLabelText(label)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit).toHaveBeenCalledWith({format:'gp',selection:{tracks:[0],range:null}});
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
  expect(screen.queryByLabelText('Include backing audio')).toBeNull();expect(screen.getByLabelText('Sample rate')).toBeVisible();
});

it('blocks an unsupported GP backing selection and permits explicit notation export',()=>{
  const issue='This passage occurs more than once. Clear Include backing audio to export the notation.',submit=vi.fn();
  render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} gpBackingIssue={()=>issue} onExport={submit} onCancel={()=>{}}/>);
  const backing=screen.getByLabelText('Include backing audio');
  expect(screen.getByRole('alert')).toHaveTextContent(issue);expect(backing).toHaveAccessibleDescription(issue);expect(backing).toHaveAttribute('aria-invalid','true');
  expect(screen.getByRole('button',{name:'Export'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit).not.toHaveBeenCalled();
  fireEvent.click(backing);expect(screen.queryByRole('alert')).toBeNull();expect(backing).not.toHaveAttribute('aria-invalid','true');
  fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit).toHaveBeenCalledWith({format:'gp',selection:{tracks:[0],range:null},backing:false});
});

it('clears only the GP include issue when backing is omitted',()=>{
  render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} failure="The output disk is full." gpBackingIssue={()=>'Clear Include backing audio to export the notation.'} onExport={()=>{}} onCancel={()=>{}}/>);
  fireEvent.click(screen.getByLabelText('Include backing audio'));expect(screen.getByRole('alert')).toHaveTextContent('The output disk is full.');
  fireEvent.click(screen.getByLabelText('Lead'));fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(screen.getByRole('alert')).toHaveTextContent('Select at least one track to export.');
  fireEvent.click(screen.getByLabelText('Include backing audio'));fireEvent.click(screen.getByLabelText('Include backing audio'));
  expect(screen.getByRole('alert')).toHaveTextContent('Select at least one track to export.');
});

it('preflights only valid GP selections with backing included',()=>{
  const preflight=vi.fn(()=>null);
  render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} gpBackingIssue={preflight} onExport={()=>{}} onCancel={()=>{}}/>);
  expect(preflight).toHaveBeenLastCalledWith({tracks:[0],range:null});preflight.mockClear();
  fireEvent.click(screen.getByLabelText('Lead'));expect(preflight).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('Include backing audio'));fireEvent.click(screen.getByLabelText('Lead'));expect(preflight).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('Include backing audio'));expect(preflight).toHaveBeenLastCalledWith({tracks:[0],range:null});preflight.mockClear();
  fireEvent.click(screen.getByLabelText('Measure range'));fireEvent.change(screen.getByLabelText('First measure'),{target:{value:'2'}});
  expect(preflight).toHaveBeenLastCalledWith({tracks:[0],range:{first:1,last:2}});preflight.mockClear();
  fireEvent.change(screen.getByLabelText('First measure'),{target:{value:'1.5'}});expect(preflight).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'midi'}});fireEvent.change(screen.getByLabelText('First measure'),{target:{value:'1'}});expect(preflight).not.toHaveBeenCalled();
});

it('submits MusicXML with the shared selection and explains what it keeps',()=>{
  const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'musicxml'}});
  expect(screen.getByText(/MusicXML keeps notes, techniques, lyrics and tempo/)).toBeVisible();expect(screen.queryByLabelText('Include backing audio')).toBeNull();
  fireEvent.click(screen.getByLabelText('Measure range'));fireEvent.change(screen.getByLabelText('First measure'),{target:{value:'2'}});
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenCalledWith({format:'musicxml',selection:{tracks:[0],range:{first:1,last:2}}});
});

it('submits ASCII tablature as a text file and explains what it keeps',()=>{
  const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'ascii'}});
  expect(screen.getByText(/ASCII tablature writes the fret numbers of stringed tracks/)).toBeVisible();
  expect(screen.getByText(/^Saves as .*\.txt$/)).toBeVisible();
  for(const label of ['Include backing audio','Paper','One file per track','Sample rate'])expect(screen.queryByLabelText(label)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenCalledWith({format:'ascii',selection:{tracks:[0],range:null}});
});

it('submits SVG with the PDF page layout and an optional transparent background',()=>{
  const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  expect(screen.queryByLabelText('Transparent background')).toBeNull();
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'svg'}});
  expect(screen.getByText(/SVG writes one file per page/)).toBeVisible();expect(screen.getByLabelText('Paper')).toBeVisible();
  const transparent=screen.getByLabelText('Transparent background');expect(transparent).not.toBeChecked();
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'svg',selection:{tracks:[0],range:null},layout,transparent:false});
  fireEvent.click(transparent);fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'svg',selection:{tracks:[0],range:null},layout,transparent:true});
});

it('submits PNG with the PDF page layout, a background choice and a resolution',()=>{
  const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  expect(screen.queryByLabelText('Resolution')).toBeNull();
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'png'}});
  expect(screen.getByText(/PNG writes one image per page/)).toBeVisible();expect(screen.getByLabelText('Paper')).toBeVisible();
  expect(screen.getByLabelText('Transparent background')).not.toBeChecked();expect(screen.getByLabelText('Resolution')).toHaveValue('300');
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'png',selection:{tracks:[0],range:null},layout,transparent:false,dpi:300});
  fireEvent.click(screen.getByLabelText('Transparent background'));fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'150'}});
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'png',selection:{tracks:[0],range:null},layout,transparent:true,dpi:150});
});

it('names files from GP8 tokens with a live preview and sends only a changed template',()=>{
  vi.useFakeTimers({now:new Date(2026,2,30,13,3)});
  try{
    const submit=vi.fn(),score=fixture();score.title='Anatole';
    render(<ExportDialog score={score} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
    const name=screen.getByLabelText('File name');expect(name).toHaveValue('%T');
    expect(screen.getByText('Saves as Anatole.gp')).toBeVisible();expect(screen.getByText(/%T title, %t track name, %n track number, %N track count, %d date, %h time/)).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit).toHaveBeenLastCalledWith({format:'gp',selection:{tracks:[0],range:null}});
    fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'png'}});
    fireEvent.change(name,{target:{value:'%T - %t (%n of %N) %d %h'}});
    expect(screen.getByText('Saves as Anatole - Lead (1 of 1) 2026-03-30 13-03.png')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Export'}));
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({format:'png',fileName:'%T - %t (%n of %N) %d %h'}));
    fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'print'}});expect(screen.queryByLabelText('File name')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit.mock.lastCall?.[0]).not.toHaveProperty('fileName');
    fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'stems'}});expect(screen.getByText(/^Saves as Anatole - Lead \(1 of 1\) 2026-03-30 13-03$/)).toBeVisible();
  }finally{vi.useRealTimers();}
});

it('offers one file per track for page exports and sends it only when chosen',()=>{
  const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  expect(screen.queryByLabelText('One file per track')).toBeNull();
  for(const format of ['pdf','svg','png']){
    fireEvent.change(screen.getByLabelText('Export format'),{target:{value:format}});
    const perTrack=screen.getByLabelText('One file per track');expect(perTrack).not.toBeChecked();
    fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit.mock.lastCall?.[0]).not.toHaveProperty('perTrack');
    fireEvent.click(perTrack);expect(screen.getByText(/Each selected track is saved as its own file in the folder you choose/)).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({format,perTrack:true}));
    fireEvent.click(perTrack);
  }
  // The default name gains the track name for one file per track, and an edited name is kept.
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'pdf'}});
  const name=screen.getByLabelText('File name') as HTMLInputElement;expect(name.value).toBe('%T');
  fireEvent.click(screen.getByLabelText('One file per track'));expect(name.value).toBe('%T - %t');
  fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({perTrack:true,fileName:'%T - %t'}));
  fireEvent.click(screen.getByLabelText('One file per track'));expect(name.value).toBe('%T');
  fireEvent.change(name,{target:{value:'%n'}});fireEvent.click(screen.getByLabelText('One file per track'));expect(name.value).toBe('%n');
  fireEvent.click(screen.getByLabelText('One file per track'));
  // Leaving the page formats drops one file per track and its default name.
  fireEvent.change(name,{target:{value:'%T'}});fireEvent.click(screen.getByLabelText('One file per track'));expect(name.value).toBe('%T - %t');
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'midi'}});expect((screen.getByLabelText('File name') as HTMLInputElement).value).toBe('%T');
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'pdf'}});expect(screen.getByLabelText('One file per track')).not.toBeChecked();
  for(const format of ['gp','print','midi','musicxml','wav','stems']){fireEvent.change(screen.getByLabelText('Export format'),{target:{value:format}});expect(screen.queryByLabelText('One file per track')).toBeNull();}
});

it('refreshes GP preflight for score and settings changes without repeating it for progress',()=>{
  const score=fixture(),preflight=vi.fn(()=>null),submit=()=>{},cancel=()=>{};
  const {rerender}=render(<ExportDialog score={score} layout={layout} busy={false} currentSpeedAvailable={true} gpBackingIssue={preflight} onExport={submit} onCancel={cancel}/>);
  preflight.mockClear();
  rerender(<ExportDialog score={score} layout={layout} busy={true} progress={{id:'job',frames:20,totalFrames:100,status:'running'}} currentSpeedAvailable={true} gpBackingIssue={preflight} onExport={submit} onCancel={cancel}/>);
  expect(preflight).not.toHaveBeenCalled();
  const changed=fixture();rerender(<ExportDialog score={changed} layout={layout} busy={false} currentSpeedAvailable={true} gpBackingIssue={preflight} onExport={submit} onCancel={cancel}/>);
  expect(preflight).toHaveBeenLastCalledWith({tracks:[0],range:null});
  const changedSettings=()=> 'The changed sync points cannot represent this selection. Clear Include backing audio to export the notation.';
  rerender(<ExportDialog score={changed} layout={layout} busy={false} currentSpeedAvailable={true} gpBackingIssue={changedSettings} onExport={submit} onCancel={cancel}/>);
  expect(screen.getByRole('alert')).toHaveTextContent('The changed sync points cannot represent this selection.');expect(screen.getByRole('button',{name:'Export'})).toBeDisabled();
});

it('keeps staves within their track group and the measure range separate while exporting partial staves',()=>{
  const score=fixture(),submit=vi.fn();score.tracks[0].addStaff(new model.Staff());score.tracks[0].addStaff(new model.Staff());
  const bass=new model.Track();bass.name='Bass';bass.addStaff(new model.Staff());score.addTrack(bass);
  render(<ExportDialog score={score} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  const tracks=screen.getByRole('group',{name:'Tracks to export'}),lead=within(tracks).getByRole('group',{name:'Lead track and staves'});
  fireEvent.click(within(lead).getByLabelText('Lead staff 2'));fireEvent.click(within(tracks).getByLabelText('Bass'));
  const measures=screen.getByRole('group',{name:'Measures to export'});expect(tracks).not.toContainElement(measures);
  fireEvent.click(within(measures).getByLabelText('Measure range'));fireEvent.change(within(measures).getByLabelText('First measure'),{target:{value:'2'}});
  fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit).toHaveBeenCalledWith({format:'gp',selection:{tracks:[0],range:{first:1,last:2},staves:{0:[0]}}});
});
it('explains an empty export selection and recovers after selecting a track',()=>{
  const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  fireEvent.click(screen.getByLabelText('Lead'));fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(screen.getByRole('alert')).toHaveTextContent('Select at least one track to export.');expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('Lead'));fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit).toHaveBeenCalledWith({format:'gp',selection:{tracks:[0],range:null}});
  expect(()=>validateSelection(1,3,{tracks:[2],range:null})).toThrow('Select existing tracks to export.');
});

it('offers a custom page draft and explicit document notation without changing the supplied page',()=>{
  const page={widthMm:250,heightMm:350,marginsMm:{top:12,right:22,bottom:32,left:42},scale:.8,profile:'document' as const},submit=vi.fn();
  render(<ExportDialog score={fixture()} layout={layout} page={page} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'pdf'}});
  fireEvent.change(screen.getByLabelText('Width (mm)'),{target:{value:'260'}});fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({format:'pdf',page:expect.objectContaining({widthMm:260,profile:'document'})}));expect(page.widthMm).toBe(250);
});
it.each([{scale:.1,marginMm:15},{scale:1,marginMm:100}])('exports a valid custom recovery page despite inactive legacy geometry %j',invalid=>{
  const page={widthMm:210,heightMm:297,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1,profile:'document' as const},submit=vi.fn();
  render(<ExportDialog score={fixture()} layout={{...layout,...invalid}} page={page} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'pdf'}});fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({format:'pdf',page}));expect(screen.queryByRole('alert')).toBeNull();
});
it.each(['gp','midi','wav'])('keeps unused legacy print geometry out of %s export validation',format=>{
  const submit=vi.fn();render(<ExportDialog score={fixture()} layout={{...layout,scale:.1}} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:format}});fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit).toHaveBeenCalledWith(expect.objectContaining({format}));
});
describe('export dialog',()=>{
  it('disables a false fixed-BPM coefficient and falls back to saved speed',()=>{
    const submit=vi.fn(),score=fixture();
    const {rerender}=render(<ExportDialog score={score} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
    fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
    const speed=screen.getByLabelText('Speed');
    fireEvent.change(speed,{target:{value:'current'}});expect(speed).toHaveValue('current');
    expect(screen.getByRole('option',{name:'Current speed coefficient'})).toBeEnabled();
    rerender(<ExportDialog score={score} layout={layout} busy={false} currentSpeedAvailable={false} onExport={submit} onCancel={()=>{}}/>);
    expect(screen.getByRole('option',{name:'Current speed coefficient'})).toBeDisabled();expect(speed).toHaveValue('saved');
    expect(screen.getByText(/fixed BPM.*saved speed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Export'}));
    expect(submit.mock.calls[0][0].audio.speed).toBe('saved');
    rerender(<ExportDialog score={score} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
    expect(speed).toHaveValue('saved');expect(screen.getByRole('option',{name:'Current speed coefficient'})).toBeEnabled();
  });
  it('validates inclusive measure drafts and sends explicit audio settings',()=>{
    const submit=vi.fn();render(<ExportDialog currentSpeedAvailable={true} score={fixture()} layout={layout} busy={false} onExport={submit} onCancel={()=>{}}/>);
    fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
    fireEvent.click(screen.getByLabelText('Measure range'));fireEvent.change(screen.getByLabelText('First measure'),{target:{value:'1.5'}});
    fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toHaveTextContent(/whole measure/i);
    fireEvent.change(screen.getByLabelText('First measure'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('Last measure'),{target:{value:'3'}});
    fireEvent.change(screen.getByLabelText('Sample rate'),{target:{value:'44100'}});fireEvent.change(screen.getByLabelText('Bit depth'),{target:{value:'24'}});
    fireEvent.click(screen.getByLabelText('Metronome'));fireEvent.click(screen.getByRole('button',{name:'Export'}));
    expect(submit).toHaveBeenCalledWith({format:'wav',selection:{tracks:[0],range:{first:1,last:2}},audio:{sampleRate:44100,bitDepth:24,speed:'saved',metronome:true,tailSeconds:2,backing:true,includeMix:true}});
  });
  it('copies print settings and disables submissions while preserving cancellation',()=>{
    const cancel=vi.fn();const {rerender}=render(<ExportDialog currentSpeedAvailable={true} score={fixture()} layout={layout} busy={false} onExport={()=>{}} onCancel={cancel}/>);
    fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'pdf'}});expect(screen.getByLabelText('Paper')).toHaveValue('A4');
    rerender(<ExportDialog currentSpeedAvailable={true} score={fixture()} layout={layout} busy={true} progress={{id:'job',frames:20,totalFrames:100,status:'running'}} onExport={()=>{}} onCancel={cancel}/>);
    expect(screen.getByRole('button',{name:'Export'})).toBeDisabled();expect(screen.getByRole('progressbar')).toHaveAttribute('value','20');
    fireEvent.click(screen.getByRole('button',{name:'Cancel export'}));expect(cancel).toHaveBeenCalledTimes(1);expect(layout.marginMm).toBe(15);
  });
  it('shows a native export failure inside the modal and retries with the selected options',()=>{
    const submit=vi.fn();const score=fixture();const {rerender}=render(<ExportDialog currentSpeedAvailable={true} score={score} layout={layout} busy={false} onExport={submit} onCancel={()=>{}}/>);
    fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
    fireEvent.change(screen.getByLabelText('Sample rate'),{target:{value:'44100'}});
    fireEvent.click(screen.getByRole('button',{name:'Export'}));
    rerender(<ExportDialog currentSpeedAvailable={true} score={score} layout={layout} busy={true} progress={{id:'job',frames:20,totalFrames:100,status:'running'}} onExport={submit} onCancel={()=>{}}/>);
    rerender(<ExportDialog currentSpeedAvailable={true} score={score} layout={layout} busy={false} progress={{id:'job',frames:20,totalFrames:100,status:'failed',error:'The output disk is full.'}} failure="Export failed" onExport={submit} onCancel={()=>{}}/>);
    const dialog=within(screen.getByRole('dialog'));expect(dialog.getByRole('alert')).toHaveTextContent('The output disk is full.');
    expect(dialog.getByRole('button',{name:'Export'})).toBeEnabled();expect(dialog.getByLabelText('Sample rate')).toHaveValue('44100');
    fireEvent.click(dialog.getByRole('button',{name:'Export'}));expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][0]).toEqual({format:'wav',selection:{tracks:[0],range:null},audio:{sampleRate:44100,bitDepth:16,speed:'saved',metronome:false,tailSeconds:2,backing:true,includeMix:true}});
  });
  it('shows preparation failures in the dialog and gives corrective validation errors precedence',()=>{
    const submit=vi.fn();render(<ExportDialog currentSpeedAvailable={true} score={fixture()} layout={layout} busy={false} failure="The instrument bank is missing." onExport={submit} onCancel={()=>{}}/>);
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('The instrument bank is missing.');
    fireEvent.click(screen.getByLabelText('Measure range'));fireEvent.change(screen.getByLabelText('First measure'),{target:{value:'1.5'}});
    fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(screen.getByRole('alert')).toHaveTextContent(/whole measure/i);expect(submit).not.toHaveBeenCalled();
  });
  it('contains keyboard focus, cancels busy exports with Escape, and restores the opener',()=>{
    const opener=document.createElement('button');document.body.append(opener);opener.focus();
    const cancel=vi.fn();const score=fixture();const {rerender,unmount}=render(<ExportDialog currentSpeedAvailable={true} score={score} layout={layout} busy={false} onExport={()=>{}} onCancel={cancel}/>);
    const format=screen.getByLabelText('Export format');const cancelButton=screen.getByRole('button',{name:'Cancel'});
    expect(format).toHaveFocus();fireEvent.keyDown(format,{key:'Tab',shiftKey:true});expect(cancelButton).toHaveFocus();
    fireEvent.keyDown(cancelButton,{key:'Tab'});expect(format).toHaveFocus();
    rerender(<ExportDialog currentSpeedAvailable={true} score={score} layout={layout} busy={true} onExport={()=>{}} onCancel={cancel}/>);
    const busyCancel=screen.getByRole('button',{name:'Cancel export'});expect(busyCancel).toHaveFocus();
    fireEvent.keyDown(busyCancel,{key:'Tab'});expect(busyCancel).toHaveFocus();fireEvent.keyDown(busyCancel,{key:'Escape'});expect(cancel).toHaveBeenCalledTimes(1);
    unmount();expect(opener).toHaveFocus();opener.remove();
  });
  it('uses the existing hit-testable dialog backdrop to contain pointer input',()=>{
    render(<ExportDialog currentSpeedAvailable={true} score={fixture()} layout={layout} busy={false} onExport={()=>{}} onCancel={()=>{}}/>);
    expect(screen.getByRole('dialog').parentElement).toHaveClass('dialog-backdrop');
  });
  it('reconciles track staff and measure selections when the score topology changes',()=>{
    const submit=vi.fn();const {rerender}=render(<ExportDialog currentSpeedAvailable={true} score={fixture()} layout={layout} busy={false} onExport={submit} onCancel={()=>{}}/>);
    fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});fireEvent.change(screen.getByLabelText('Sample rate'),{target:{value:'44100'}});
    fireEvent.click(screen.getByLabelText('Measure range'));fireEvent.change(screen.getByLabelText('First measure'),{target:{value:'3'}});
    const changed=fixture();changed.masterBars.splice(1);const added=new model.Track();added.name='Bass';added.addStaff(new model.Staff());added.addStaff(new model.Staff());changed.addTrack(added);
    rerender(<ExportDialog currentSpeedAvailable={true} score={changed} layout={layout} busy={false} onExport={submit} onCancel={()=>{}}/>);
    fireEvent.click(screen.getByLabelText('Bass'));expect(screen.getByLabelText('Bass staff 1')).toBeInTheDocument();expect(screen.getByLabelText('Bass staff 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit).toHaveBeenCalledWith({format:'wav',selection:{tracks:[0,1],range:null},audio:{sampleRate:44100,bitDepth:16,speed:'saved',metronome:false,tailSeconds:2,backing:true,includeMix:true}});
    rerender(<ExportDialog currentSpeedAvailable={true} score={fixture()} layout={layout} busy={false} onExport={submit} onCancel={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit.mock.calls[1][0].selection.tracks).toEqual([0]);
  });
});

it('says in the audio export that a cabinet response is missing, and only there',async()=>{
  const sound=soundPreset('crunch');sound.effects.cabinet.enabled=true;sound.effects.cabinet.ir={id:'d'.repeat(32),name:'Shared cab',levelDb:0};
  const before=structuredClone(sound);
  render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} sounds={{'base/0':sound}} trackNames={{'base/0':'Lead'}} onExport={()=>{}} onCancel={()=>{}}/>);
  expect(screen.queryByText(/Shared cab/)).toBeNull();
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
  expect((await screen.findByText(/Shared cab/)).textContent).toMatch(/^Lead: The impulse response “Shared cab” is not in this computer's cabinet library/);
  expect(sound).toEqual(before);
  expect(vi.mocked(invoke)).toHaveBeenCalledWith('cabinet_ir_status',{ids:['d'.repeat(32)]});
});
