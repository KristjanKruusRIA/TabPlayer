// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,render,screen,fireEvent,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { ExportDialog } from './ExportDialog';
afterEach(cleanup);
function fixture(){const score=new model.Score();for(let i=0;i<3;i++)score.addMasterBar(new model.MasterBar());const track=new model.Track();track.name='Lead';score.addTrack(track);return score;}
const layout={paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'ScoreTab' as const};
const audio={sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:2,backing:true,includeMix:true};
const dialog=(submit:()=>void)=>render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);

it('normalizes mixed audio to a chosen RMS level only when asked',()=>{
  const submit=vi.fn();dialog(submit);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
  const box=screen.getByLabelText('Normalize'),level=screen.getByLabelText('Normalized level (dB RMS)');
  expect(box).not.toBeChecked();expect(level).toBeDisabled();expect(level).toHaveValue(-16);
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'wav',selection:{tracks:[0],range:null},audio});
  fireEvent.click(box);expect(level).toBeEnabled();
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'wav',selection:{tracks:[0],range:null},audio:{...audio,normalizeRmsDb:-16}});
  fireEvent.change(level,{target:{value:'-12.5'}});fireEvent.click(within(screen.getByRole('radiogroup',{name:'File type'})).getByRole('radio',{name:'AIFF'}));
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'wav',selection:{tracks:[0],range:null},audio:{...audio,container:'aiff',normalizeRmsDb:-12.5}});
});

it('refuses levels outside -30 to -6 dB RMS and leaves stems unnormalized',()=>{
  const submit=vi.fn();dialog(submit);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
  fireEvent.click(screen.getByLabelText('Normalize'));
  for(const value of ['-31','-5','']){
    fireEvent.change(screen.getByLabelText('Normalized level (dB RMS)'),{target:{value}});
    fireEvent.click(screen.getByRole('button',{name:'Export'}));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a normalization level from -30 to -6 dB RMS.');
  }
  expect(submit).not.toHaveBeenCalled();
  // Stems keep each track's level: the option is not offered and not sent.
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'stems'}});
  expect(screen.queryByLabelText('Normalize')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'stems',selection:{tracks:[0],range:null},audio});
});
