// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SongPanel } from './SongPanel';
import { applySongEdit } from './song';
import { music } from './fixtures';

afterEach(cleanup);
it('edits all eight metadata strings including multiline text and empty values',()=>{
  const score=music();score.album='Old album';
  render(<SongPanel score={score} busy={false} onEdit={edit=>{applySongEdit(score,edit);}}/>);
  const fields=[['Subtitle','subTitle','Subtitle'],['Album','album',''],['Lyrics author','words','Lyricist'],['Music author','music','Composer'],['Copyright','copyright','© 2026'],['Transcriber','tab','Transcriber'],['Notices','notices','Line one\nLine two'],['Instructions','instructions','Play softly\nThen loudly']] as const;
  for(const [label,,value] of fields)fireEvent.change(screen.getByLabelText(label),{target:{value}});
  fireEvent.click(screen.getByRole('button',{name:'Apply song metadata'}));
  expect(score.subTitle).toBe('Subtitle');expect(score.album).toBe('');expect(score.words).toBe('Lyricist');expect(score.music).toBe('Composer');expect(score.copyright).toBe('© 2026');expect(score.tab).toBe('Transcriber');expect(score.notices).toBe('Line one\nLine two');expect(score.instructions).toBe('Play softly\nThen loudly');
});

it('refreshes metadata from history and disables changes while busy',()=>{
  const score=music();score.album='First';const props={score,busy:false,onEdit:()=>{}},view=render(<SongPanel {...props}/>);
  fireEvent.change(screen.getByLabelText('Album'),{target:{value:'Unsaved'}});
  const restored=music();restored.album='Restored';view.rerender(<SongPanel {...props} score={restored}/>);expect(screen.getByLabelText('Album')).toHaveValue('Restored');
  view.rerender(<SongPanel {...props} score={restored} busy/>);expect(screen.getByLabelText('Album')).toBeDisabled();expect(screen.getByRole('button',{name:'Apply song metadata'})).toBeDisabled();
});
