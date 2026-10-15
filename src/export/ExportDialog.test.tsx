// @vitest-environment jsdom
import { afterEach,describe,expect,it,vi } from 'vitest';
import { cleanup,render,screen,fireEvent,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { ExportDialog } from './ExportDialog';
import { validateSelection } from './types';
afterEach(cleanup);
function fixture(){const score=new model.Score();for(let i=0;i<3;i++)score.addMasterBar(new model.MasterBar());const track=new model.Track();track.name='Lead';score.addTrack(track);return score;}
const layout={paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'ScoreTab' as const};

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
