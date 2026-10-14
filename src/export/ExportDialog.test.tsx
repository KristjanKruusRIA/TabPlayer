// @vitest-environment jsdom
import { afterEach,describe,expect,it,vi } from 'vitest';
import { cleanup,render,screen,fireEvent,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { ExportDialog } from './ExportDialog';
afterEach(cleanup);
function fixture(){const score=new model.Score();for(let i=0;i<3;i++)score.addMasterBar(new model.MasterBar());const track=new model.Track();track.name='Lead';score.addTrack(track);return score;}
const layout={paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'ScoreTab' as const};
describe('export dialog',()=>{
  it('validates inclusive measure drafts and sends explicit audio settings',()=>{
    const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} onExport={submit} onCancel={()=>{}}/>);
    fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
    fireEvent.click(screen.getByLabelText('Measure range'));fireEvent.change(screen.getByLabelText('First measure'),{target:{value:'1.5'}});
    fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toHaveTextContent(/whole measure/i);
    fireEvent.change(screen.getByLabelText('First measure'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('Last measure'),{target:{value:'3'}});
    fireEvent.change(screen.getByLabelText('Sample rate'),{target:{value:'44100'}});fireEvent.change(screen.getByLabelText('Bit depth'),{target:{value:'24'}});
    fireEvent.click(screen.getByLabelText('Metronome'));fireEvent.click(screen.getByRole('button',{name:'Export'}));
    expect(submit).toHaveBeenCalledWith({format:'wav',selection:{tracks:[0],range:{first:1,last:2}},audio:{sampleRate:44100,bitDepth:24,speed:'saved',metronome:true,tailSeconds:2,backing:true,includeMix:true}});
  });
  it('copies print settings and disables submissions while preserving cancellation',()=>{
    const cancel=vi.fn();const {rerender}=render(<ExportDialog score={fixture()} layout={layout} busy={false} onExport={()=>{}} onCancel={cancel}/>);
    fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'pdf'}});expect(screen.getByLabelText('Paper')).toHaveValue('A4');
    rerender(<ExportDialog score={fixture()} layout={layout} busy={true} progress={{id:'job',frames:20,totalFrames:100,status:'running'}} onExport={()=>{}} onCancel={cancel}/>);
    expect(screen.getByRole('button',{name:'Export'})).toBeDisabled();expect(screen.getByRole('progressbar')).toHaveAttribute('value','20');
    fireEvent.click(screen.getByRole('button',{name:'Cancel export'}));expect(cancel).toHaveBeenCalledTimes(1);expect(layout.marginMm).toBe(15);
  });
  it('shows a native export failure inside the modal and retries with the selected options',()=>{
    const submit=vi.fn();const score=fixture();const {rerender}=render(<ExportDialog score={score} layout={layout} busy={false} onExport={submit} onCancel={()=>{}}/>);
    fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
    fireEvent.change(screen.getByLabelText('Sample rate'),{target:{value:'44100'}});
    fireEvent.click(screen.getByRole('button',{name:'Export'}));
    rerender(<ExportDialog score={score} layout={layout} busy={true} progress={{id:'job',frames:20,totalFrames:100,status:'running'}} onExport={submit} onCancel={()=>{}}/>);
    rerender(<ExportDialog score={score} layout={layout} busy={false} progress={{id:'job',frames:20,totalFrames:100,status:'failed',error:'The output disk is full.'}} failure="Export failed" onExport={submit} onCancel={()=>{}}/>);
    const dialog=within(screen.getByRole('dialog'));expect(dialog.getByRole('alert')).toHaveTextContent('The output disk is full.');
    expect(dialog.getByRole('button',{name:'Export'})).toBeEnabled();expect(dialog.getByLabelText('Sample rate')).toHaveValue('44100');
    fireEvent.click(dialog.getByRole('button',{name:'Export'}));expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][0]).toEqual({format:'wav',selection:{tracks:[0],range:null},audio:{sampleRate:44100,bitDepth:16,speed:'saved',metronome:false,tailSeconds:2,backing:true,includeMix:true}});
  });
  it('shows preparation failures in the dialog and gives corrective validation errors precedence',()=>{
    const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} failure="The instrument bank is missing." onExport={submit} onCancel={()=>{}}/>);
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('The instrument bank is missing.');
    fireEvent.click(screen.getByLabelText('Measure range'));fireEvent.change(screen.getByLabelText('First measure'),{target:{value:'1.5'}});
    fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(screen.getByRole('alert')).toHaveTextContent(/whole measure/i);expect(submit).not.toHaveBeenCalled();
  });
  it('contains keyboard focus, cancels busy exports with Escape, and restores the opener',()=>{
    const opener=document.createElement('button');document.body.append(opener);opener.focus();
    const cancel=vi.fn();const score=fixture();const {rerender,unmount}=render(<ExportDialog score={score} layout={layout} busy={false} onExport={()=>{}} onCancel={cancel}/>);
    const format=screen.getByLabelText('Export format');const cancelButton=screen.getByRole('button',{name:'Cancel'});
    expect(format).toHaveFocus();fireEvent.keyDown(format,{key:'Tab',shiftKey:true});expect(cancelButton).toHaveFocus();
    fireEvent.keyDown(cancelButton,{key:'Tab'});expect(format).toHaveFocus();
    rerender(<ExportDialog score={score} layout={layout} busy={true} onExport={()=>{}} onCancel={cancel}/>);
    const busyCancel=screen.getByRole('button',{name:'Cancel export'});expect(busyCancel).toHaveFocus();
    fireEvent.keyDown(busyCancel,{key:'Tab'});expect(busyCancel).toHaveFocus();fireEvent.keyDown(busyCancel,{key:'Escape'});expect(cancel).toHaveBeenCalledTimes(1);
    unmount();expect(opener).toHaveFocus();opener.remove();
  });
  it('uses the existing hit-testable dialog backdrop to contain pointer input',()=>{
    render(<ExportDialog score={fixture()} layout={layout} busy={false} onExport={()=>{}} onCancel={()=>{}}/>);
    expect(screen.getByRole('dialog').parentElement).toHaveClass('dialog-backdrop');
  });
  it('reconciles track staff and measure selections when the score topology changes',()=>{
    const submit=vi.fn();const {rerender}=render(<ExportDialog score={fixture()} layout={layout} busy={false} onExport={submit} onCancel={()=>{}}/>);
    fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});fireEvent.change(screen.getByLabelText('Sample rate'),{target:{value:'44100'}});
    fireEvent.click(screen.getByLabelText('Measure range'));fireEvent.change(screen.getByLabelText('First measure'),{target:{value:'3'}});
    const changed=fixture();changed.masterBars.splice(1);const added=new model.Track();added.name='Bass';added.addStaff(new model.Staff());added.addStaff(new model.Staff());changed.addTrack(added);
    rerender(<ExportDialog score={changed} layout={layout} busy={false} onExport={submit} onCancel={()=>{}}/>);
    fireEvent.click(screen.getByLabelText('Bass'));expect(screen.getByLabelText('Bass staff 1')).toBeInTheDocument();expect(screen.getByLabelText('Bass staff 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit).toHaveBeenCalledWith({format:'wav',selection:{tracks:[0,1],range:null},audio:{sampleRate:44100,bitDepth:16,speed:'saved',metronome:false,tailSeconds:2,backing:true,includeMix:true}});
    rerender(<ExportDialog score={fixture()} layout={layout} busy={false} onExport={submit} onCancel={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Export'}));expect(submit.mock.calls[1][0].selection.tracks).toEqual([0]);
  });
});
