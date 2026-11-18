// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,render,screen,fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { ExportDialog } from './ExportDialog';
afterEach(cleanup);
function fixture(){const score=new model.Score();for(let i=0;i<3;i++)score.addMasterBar(new model.MasterBar());const track=new model.Track();track.name='Lead';score.addTrack(track);return score;}
const layout={paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'ScoreTab' as const};
const audio={sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:2,backing:true,includeMix:true};
const dialog=(submit:()=>void,countInBars?:number)=>render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} countInBars={countInBars} onExport={submit} onCancel={()=>{}}/>);

it('offers the count-in for audio files only, off by default, and sends it only when chosen',()=>{
  const submit=vi.fn();dialog(submit,2);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
  const box=screen.getByLabelText('Include count-in');
  expect(box).not.toBeChecked();expect(box).toBeEnabled();
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'wav',selection:{tracks:[0],range:null},audio});
  fireEvent.click(box);
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'wav',selection:{tracks:[0],range:null},audio:{...audio,countIn:true}});
  // Stems keep each track's own timeline: the option is not offered and not sent.
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'stems'}});
  expect(screen.queryByLabelText('Include count-in')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'stems',selection:{tracks:[0],range:null},audio});
});

it('disables the count-in when the practice settings define no bars',()=>{
  const submit=vi.fn();dialog(submit,0);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
  expect(screen.getByLabelText('Include count-in')).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'wav',selection:{tracks:[0],range:null},audio});
});

it('says only what the audio export still leaves out where the count-in is offered, and why the option is off',()=>{
  dialog(vi.fn(),2);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
  expect(screen.getByText('Audio export does not include progressive speed changes.')).toBeInTheDocument();
  expect(screen.queryByText(/does not include count-in/)).toBeNull();
  expect(screen.getByText(/count-in bars from the practice settings \(2\)/)).toBeInTheDocument();
  expect(screen.queryByText(/Count-in is unavailable/)).toBeNull();
  // Stems have no count-in option, so they say it is left out.
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'stems'}});
  expect(screen.getByText('Stems do not include count-in or progressive speed changes.')).toBeInTheDocument();
  expect(screen.queryByText('Audio export does not include progressive speed changes.')).toBeNull();
});

it('explains how to enable the count-in when the practice settings have no count-in bars',()=>{
  dialog(vi.fn(),0);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
  expect(screen.getByLabelText('Include count-in')).toBeDisabled();
  expect(screen.getByText('Count-in is unavailable while the practice settings have no count-in bars. Set count-in bars in the practice settings to turn it on.')).toBeInTheDocument();
  expect(screen.queryByText(/count-in bars from the practice settings \(0\)/)).toBeNull();
});
