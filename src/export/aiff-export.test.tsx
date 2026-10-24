// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,render,screen,fireEvent,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { ExportDialog } from './ExportDialog';
afterEach(cleanup);
function fixture(){const score=new model.Score();for(let i=0;i<3;i++)score.addMasterBar(new model.MasterBar());const track=new model.Track();track.name='Lead';score.addTrack(track);score.title='Song';return score;}
const layout={paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'ScoreTab' as const};
const audio={sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:2,backing:true,includeMix:true};

it('exports mixed audio as AIFF and names the file .aiff',()=>{
  const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  const format=screen.getByLabelText('Export format');
  expect(within(format).getByRole('option',{name:'Mixed audio'})).toHaveValue('wav');expect(within(format).getByRole('option',{name:'Audio stems'})).toHaveValue('stems');
  fireEvent.change(format,{target:{value:'wav'}});
  const type=screen.getByLabelText('File type');expect(type).toHaveValue('wav');
  expect(within(type).getAllByRole('option').map(option=>option.textContent)).toEqual(['WAV','AIFF']);
  expect(screen.getByText(/^Saves as .*\.wav$/)).toBeInTheDocument();
  fireEvent.change(type,{target:{value:'aiff'}});
  expect(screen.getByText(/^Saves as .*\.aiff$/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'wav',selection:{tracks:[0],range:null},audio:{...audio,container:'aiff'}});
  // Back to WAV, the request is exactly as before AIFF.
  fireEvent.change(type,{target:{value:'wav'}});
  expect(screen.getByText(/^Saves as .*\.wav$/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'wav',selection:{tracks:[0],range:null},audio});
});

it('exports stems as AIFF',()=>{
  const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'stems'}});
  fireEvent.change(screen.getByLabelText('File type'),{target:{value:'aiff'}});
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'stems',selection:{tracks:[0],range:null},audio:{...audio,container:'aiff'}});
});
