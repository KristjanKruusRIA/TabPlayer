// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,render,screen,fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { ExportDialog } from './ExportDialog';
afterEach(cleanup);
function fixture(){const score=new model.Score();for(let i=0;i<3;i++)score.addMasterBar(new model.MasterBar());const track=new model.Track();track.name='Lead';score.addTrack(track);score.title='Song';return score;}
const layout={paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'ScoreTab' as const};
const audio={sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:2,backing:true,includeMix:true};

it('exports mixed audio as FLAC, normalized or not, and names the file .flac',()=>{
  const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
  const type=screen.getByLabelText('File type');
  fireEvent.change(type,{target:{value:'flac'}});expect(type).toHaveValue('flac');
  expect(screen.getByText(/^Saves as .*\.flac$/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'wav',selection:{tracks:[0],range:null},audio:{...audio,container:'flac'}});
  fireEvent.click(screen.getByLabelText('Normalize'));
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'wav',selection:{tracks:[0],range:null},audio:{...audio,container:'flac',normalizeRmsDb:-16}});
  // From FLAC to AIFF and back to WAV, only the chosen type is sent.
  fireEvent.change(type,{target:{value:'aiff'}});expect(screen.getByText(/^Saves as .*\.aiff$/)).toBeInTheDocument();
  fireEvent.change(type,{target:{value:'wav'}});
  fireEvent.click(screen.getByLabelText('Normalize'));
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'wav',selection:{tracks:[0],range:null},audio});
});

it('exports stems as FLAC',()=>{
  const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'stems'}});
  fireEvent.change(screen.getByLabelText('File type'),{target:{value:'flac'}});
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'stems',selection:{tracks:[0],range:null},audio:{...audio,container:'flac'}});
});
