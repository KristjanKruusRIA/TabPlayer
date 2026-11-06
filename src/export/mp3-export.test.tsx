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

it('exports mixed audio as MP3, names the file .mp3 and hides the bit depth it ignores',()=>{
  const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
  const type=screen.getByRole('radiogroup',{name:'File type'});
  expect(screen.getByRole('radiogroup',{name:'Bit depth'})).toBeInTheDocument();
  fireEvent.click(within(type).getByRole('radio',{name:'MP3 (compressed)'}));
  expect(within(type).getByRole('radio',{name:'MP3 (compressed)'})).toBeChecked();
  expect(screen.getByText(/^Saves as .*\.mp3$/)).toBeInTheDocument();
  expect(screen.queryByRole('radiogroup',{name:'Bit depth'})).toBeNull();
  expect(screen.getByText(/constant 256 kbit/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'wav',selection:{tracks:[0],range:null},audio:{...audio,container:'mp3'}});
  fireEvent.click(screen.getByLabelText('Normalize'));
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'wav',selection:{tracks:[0],range:null},audio:{...audio,container:'mp3',normalizeRmsDb:-16}});
  // Back to WAV, the bit depth returns and no type is sent.
  fireEvent.click(screen.getByLabelText('Normalize'));
  fireEvent.click(within(type).getByRole('radio',{name:'WAV'}));
  expect(screen.getByRole('radiogroup',{name:'Bit depth'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'wav',selection:{tracks:[0],range:null},audio});
});

it('exports stems as MP3',()=>{
  const submit=vi.fn();render(<ExportDialog score={fixture()} layout={layout} busy={false} currentSpeedAvailable={true} onExport={submit} onCancel={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'stems'}});
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'File type'})).getByRole('radio',{name:'MP3 (compressed)'}));
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(submit).toHaveBeenLastCalledWith({format:'stems',selection:{tracks:[0],range:null},audio:{...audio,container:'mp3'}});
});
