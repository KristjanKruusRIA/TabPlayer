// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { act,cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PracticePanel } from './PracticePanel';
import { DEFAULT_PRACTICE,type PracticeSettings } from './practice-types';

afterEach(cleanup);
const settings=():PracticeSettings=>structuredClone(DEFAULT_PRACTICE);
const change=(label:string,value:string)=>fireEvent.change(screen.getByLabelText(label),{target:{value}});
const apply=()=>fireEvent.click(screen.getByRole('button',{name:'Apply practice settings'}));
it('applies_one_complete_detached_relative_fixed_or_progressive_draft',()=>{
  const changes:PracticeSettings[]=[],accepted=settings();render(<PracticePanel settings={accepted} busy={false} hasBacking={false} onChange={value=>changes.push(value)}/>);
  expect(screen.queryByRole('button',{name:'Apply practice settings'})).toBeInTheDocument();
  for(const [index,value]of ['123','10','300'].entries()){change('Relative speed (%)',value);expect(changes).toHaveLength(index);apply();}
  expect(changes.map(value=>value.tempo)).toEqual([{kind:'relative',ratio:1.23},{kind:'relative',ratio:.1},{kind:'relative',ratio:3}]);
  change('Tempo mode','fixed');change('Fixed tempo (BPM)','100.5');apply();
  expect(changes[3]).toEqual({tempo:{kind:'fixed',bpm:100.5},metronome:{enabled:false,volume:.4,visual:false,sound:'beep'},countIn:{bars:0,betweenLoops:false}});
  change('Tempo mode','progressive');change('Starting speed (%)','50');change('Finishing speed (%)','100');change('Increment (percentage points)','20');change('Repetitions per speed','2');expect(changes).toHaveLength(4);apply();
  expect(changes[4]).toEqual({tempo:{kind:'progressive',start:.5,end:1,step:.2,repetitions:2},metronome:{enabled:false,volume:.4,visual:false,sound:'beep'},countIn:{bars:0,betweenLoops:false}});
  expect(changes[0]).not.toBe(accepted);expect(changes[0].metronome).not.toBe(accepted.metronome);expect(changes[0].countIn).not.toBe(accepted.countIn);expect(accepted).toEqual(DEFAULT_PRACTICE);
});
it('rejects_incomplete_or_invalid_numeric_drafts_without_dispatch',()=>{
  const changes:PracticeSettings[]=[];render(<PracticePanel settings={settings()} busy={false} hasBacking={false} onChange={value=>changes.push(value)}/>);
  for(const value of ['','9','301']){change('Relative speed (%)',value);apply();expect(screen.getByRole('alert')).toBeInTheDocument();}
  change('Relative speed (%)','100');change('Count-in bars','');apply();
  change('Count-in bars','1.5');apply();change('Count-in bars','17');apply();change('Count-in bars','0');
  change('Metronome volume (%)','');apply();change('Metronome volume (%)','101');apply();change('Metronome volume (%)','40');
  change('Tempo mode','progressive');change('Starting speed (%)','100');change('Finishing speed (%)','50');apply();change('Finishing speed (%)','100');change('Increment (percentage points)','0');apply();change('Increment (percentage points)','10');change('Repetitions per speed','1.5');apply();
  expect(changes).toEqual([]);
});
it('rapid_volume_visual_edits_and_mode_switches_preserve_one_draft',()=>{
  const changes:PracticeSettings[]=[];render(<PracticePanel settings={settings()} busy={false} hasBacking={false} onChange={value=>changes.push(value)}/>);
  act(()=>{fireEvent.click(screen.getByLabelText('Metronome'));change('Metronome volume (%)','0');fireEvent.click(screen.getByLabelText('Visual metronome'));change('Count-in bars','2');fireEvent.click(screen.getByLabelText('Count in between loops'));});
  change('Tempo mode','fixed');change('Tempo mode','progressive');change('Tempo mode','relative');
  expect(changes).toEqual([]);apply();
  expect(changes).toEqual([{tempo:{kind:'relative',ratio:1},metronome:{enabled:true,volume:0,visual:true,sound:'beep'},countIn:{bars:2,betweenLoops:true}}]);
  change('Metronome volume (%)','100');expect(changes[0].metronome.volume).toBe(0);
});
it('unchanged_accepted_status_preserves_drafts_changed_settings_and_document_key_reset_them',()=>{
  const accepted=settings(),props={settings:accepted,busy:false,hasBacking:false,onChange:()=>{}};
  const view=render(<PracticePanel key="document-a" {...props}/>);change('Relative speed (%)','123');change('Count-in bars','2');
  view.rerender(<PracticePanel key="document-a" {...props} settings={structuredClone(accepted)}/>);expect(screen.getByLabelText('Relative speed (%)')).toHaveValue(123);expect(screen.getByLabelText('Count-in bars')).toHaveValue(2);
  view.rerender(<PracticePanel key="document-a" {...props} settings={{tempo:{ratio:1,kind:'relative'},countIn:{betweenLoops:false,bars:0},metronome:{visual:false,volume:.4,enabled:false}}}/>);expect(screen.getByLabelText('Relative speed (%)')).toHaveValue(123);
  view.rerender(<PracticePanel key="document-a" {...props} settings={{...accepted,tempo:{kind:'relative',ratio:.75}}}/>);expect(screen.getByLabelText('Relative speed (%)')).toHaveValue(75);expect(screen.getByLabelText('Count-in bars')).toHaveValue(0);
  change('Relative speed (%)','123');view.rerender(<PracticePanel key="document-b" {...props}/>);expect(screen.getByLabelText('Relative speed (%)')).toHaveValue(100);
});
it('busy_guards_prevent_dispatch_and_a_backing_keeps_fixed_mode_inside_its_range',()=>{
  const changes:PracticeSettings[]=[],props={settings:settings(),busy:false,hasBacking:true,authored:{min:120,max:120},onChange:(value:PracticeSettings)=>changes.push(value)};
  const view=render(<PracticePanel {...props}/>);expect(screen.getByRole('option',{name:'Fixed'})).not.toBeDisabled();expect(screen.getByText(/the backing follows the fixed tempo/)).toBeInTheDocument();
  change('Tempo mode','fixed');change('Fixed tempo (BPM)','11.9');apply();expect(changes).toEqual([]);expect(screen.getByRole('alert')).toHaveTextContent('Fixed tempo 11.9 BPM would stretch the backing track outside 10% to 300% of its speed. For this score choose 12 to 300 BPM. A muted backing counts too.');
  change('Fixed tempo (BPM)','90');apply();expect(changes).toHaveLength(1);expect(changes[0].tempo).toEqual({kind:'fixed',bpm:90});
  view.rerender(<PracticePanel {...props} busy/>);expect(screen.getByRole('button',{name:'Apply practice settings'})).toBeDisabled();apply();expect(changes).toHaveLength(1);
});
it('unchanged_percentage_fields_retain_the_exact_accepted_numbers',()=>{
  const changes:PracticeSettings[]=[],accepted:PracticeSettings={tempo:{kind:'progressive',start:.10501504513540623,end:1.995987963891675,step:.03501504513540623,repetitions:2},metronome:{enabled:true,volume:.10501504513540623,visual:true,sound:'beep'},countIn:{bars:1,betweenLoops:true}};
  render(<PracticePanel settings={accepted} busy={false} hasBacking={false} onChange={value=>changes.push(value)}/>);apply();expect(changes).toEqual([accepted]);
  change('Count-in bars','2');apply();expect(changes[1]).toEqual({...accepted,countIn:{bars:2,betweenLoops:true}});
});
it('apply_rejection_keeps_the_editable_draft_during_unchanged_status_updates',()=>{
  const accepted=settings(),props={settings:accepted,busy:false,hasBacking:false,onChange:()=>{throw new Error('Audio command rejected.');}};
  const view=render(<PracticePanel {...props}/>);change('Relative speed (%)','123');apply();expect(screen.getByRole('alert')).toHaveTextContent('Audio command rejected.');
  view.rerender(<PracticePanel {...props} settings={structuredClone(accepted)}/>);expect(screen.getByLabelText('Relative speed (%)')).toHaveValue(123);expect(screen.getByRole('alert')).toHaveTextContent('Audio command rejected.');
});
it('chooses_the_metronome_sound_and_reads_old_settings_as_the_beep',()=>{
  const changes:PracticeSettings[]=[],old=settings();delete old.metronome.sound;
  const {rerender}=render(<PracticePanel settings={old} busy={false} hasBacking={false} onChange={value=>changes.push(value)}/>);
  const sound=screen.getByLabelText('Metronome sound');expect(sound).toHaveValue('beep');
  expect([...(sound as HTMLSelectElement).options].map(option=>[option.value,option.textContent])).toEqual([['beep','Beep'],['woodblock','Woodblock'],['cowbell','Cowbell'],['stick','Stick']]);
  change('Metronome sound','woodblock');expect(changes).toEqual([]);apply();
  expect(changes).toHaveLength(1);expect(changes[0].metronome).toEqual({enabled:false,volume:.4,visual:false,sound:'woodblock'});
  rerender(<PracticePanel settings={{...old,metronome:{...old.metronome,sound:'cowbell'}}} busy={false} hasBacking={false} onChange={value=>changes.push(value)}/>);
  expect(screen.getByLabelText('Metronome sound')).toHaveValue('cowbell');
});

it('applying_the_panel_never_resets_a_key_shift_and_adds_none_when_there_is_none',()=>{
  const changes:PracticeSettings[]=[];
  const view=render(<PracticePanel settings={{...settings(),tonality:5}} busy={false} hasBacking={false} onChange={value=>changes.push(value)}/>);
  change('Relative speed (%)','80');apply();
  expect(changes).toHaveLength(1);expect(changes[0].tonality).toBe(5);expect(changes[0].tempo).toEqual({kind:'relative',ratio:.8});
  // A new shift from elsewhere is a changed accepted setting: the panel's draft restarts from it and keeps it.
  view.rerender(<PracticePanel settings={{...settings(),tonality:-2}} busy={false} hasBacking={false} onChange={value=>changes.push(value)}/>);
  apply();expect(changes[1].tonality).toBe(-2);
  view.rerender(<PracticePanel settings={settings()} busy={false} hasBacking={false} onChange={value=>changes.push(value)}/>);
  apply();expect(Object.hasOwn(changes[2],'tonality')).toBe(false);
});

it('a_key_step_from_the_transport_keeps_an_unapplied_draft',()=>{
  const changes:PracticeSettings[]=[];
  const view=render(<PracticePanel settings={settings()} busy={false} hasBacking={false} onChange={value=>changes.push(value)}/>);
  change('Relative speed (%)','80');change('Count-in bars','2');
  view.rerender(<PracticePanel settings={{...settings(),tonality:3}} busy={false} hasBacking={false} onChange={value=>changes.push(value)}/>);
  expect(screen.getByLabelText('Relative speed (%)')).toHaveValue(80);expect(screen.getByLabelText('Count-in bars')).toHaveValue(2);
  apply();expect(changes).toHaveLength(1);expect(changes[0].tonality).toBe(3);expect(changes[0].tempo).toEqual({kind:'relative',ratio:.8});
});
