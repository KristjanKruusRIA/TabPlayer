// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AuthorDefaultsPanel } from './AuthorDefaultsPanel';
import { emptyAuthorDefaults } from '../workspace/author-defaults';
import { music } from './fixtures';

afterEach(cleanup);
const change=(label:string,value:string)=>fireEvent.change(screen.getByLabelText(label,{exact:true}),{target:{value}});

it('saves edited defaults for new scores without editing the open score',()=>{
  const onSave=vi.fn(()=>true),score=music();score.artist='Existing';
  render(<AuthorDefaultsPanel score={score} load={()=>emptyAuthorDefaults} onSave={onSave}/>);
  change('Default artist','The Band');change('Default lyrics author','Ann');change('Default music author','Ben');change('Default transcriber','Cy');change('Default copyright','© The Band');
  fireEvent.click(screen.getByRole('button',{name:'Save defaults'}));
  expect(onSave).toHaveBeenCalledWith({artist:'The Band',words:'Ann',music:'Ben',tab:'Cy',copyright:'© The Band'});
  expect(screen.getByRole('status')).toHaveTextContent('Saved. Scores you create with New start with these details.');
  expect(score.artist).toBe('Existing');
});

it('copies the open score details into the form and reports a failed save',()=>{
  const score=music();Object.assign(score,{artist:'Art',words:'W',music:'M',tab:'T',copyright:'C'});
  render(<AuthorDefaultsPanel score={score} load={()=>({...emptyAuthorDefaults,artist:'Old'})} onSave={()=>false}/>);
  expect(screen.getByLabelText('Default artist',{exact:true})).toHaveValue('Old');
  fireEvent.click(screen.getByRole('button',{name:'Use this score’s details'}));
  expect(screen.getByLabelText('Default transcriber',{exact:true})).toHaveValue('T');
  fireEvent.click(screen.getByRole('button',{name:'Save defaults'}));
  expect(screen.getByRole('status')).toHaveTextContent('These defaults could not be stored, so they last only until TabPlayer closes.');
});

it('shortens copied details without splitting a character, says so, and describes every field',()=>{
  const score=music();score.copyright=`${'c'.repeat(999)}🎸 tail`;
  render(<AuthorDefaultsPanel score={score} load={()=>emptyAuthorDefaults} onSave={()=>true}/>);
  fireEvent.click(screen.getByRole('button',{name:'Use this score’s details'}));
  const copyright=screen.getByLabelText('Default copyright',{exact:true}) as HTMLInputElement;
  expect(copyright.value).toBe('c'.repeat(999));
  expect(screen.getByRole('status')).toHaveTextContent('Copied this score’s details, shortening long ones to 1000 characters. Save to keep them.');
  expect(copyright).toHaveAccessibleDescription(/Scores you create with New start with these details/);
});
