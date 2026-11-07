// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { useState } from 'react';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { EngravingFonts,FontRole } from './fonts';
import { FontRolesFields } from './FontRolesFields';

afterEach(cleanup);
type Status={failed:string[];substituted:string[]}|null;
interface Props {value?:EngravingFonts;busy?:boolean;texts?:Partial<Record<FontRole,string[]>>;status?:Status}
/** Holds the value the way the panel's draft does and records every change. */
function setup(props:Props={}) {
  const changes:EngravingFonts[]=[],invalid:string[]=[];
  function Harness(more:Props) {
    const [value,setValue]=useState<EngravingFonts|undefined>(props.value);
    return <FontRolesFields value={value} busy={more.busy??props.busy??false} texts={more.texts??props.texts??{}} status={more.status??props.status??null} onInvalid={message=>invalid.push(message)} onChange={next=>{changes.push(next);setValue(next);}}/>;
  }
  const view=render(<Harness/>);
  return {changes,invalid,rerender:(more:Props)=>view.rerender(<Harness {...more}/>)};
}
const select=(name:string)=>screen.getByRole('combobox',{name}) as HTMLSelectElement;

it('role_grid_has_one_labelled_row_per_role',()=>{
  setup();
  for(const role of ['Title block','Page header','Page footer','Chord names','Staff text','Lyrics','Track names','Bar numbers','Markers','Tab numbers']){
    expect(select(`${role} font`)).toHaveValue('inherit');expect(screen.getByLabelText(`${role} size (%)`)).toHaveValue(null);
    expect(select(`${role} bold`)).toHaveValue('inherit');expect(select(`${role} italic`)).toHaveValue('inherit');
  }
  expect(select('Music font')).toHaveValue('bravura');
});

it('choices_change_only_that_role_and_keep_the_value_clean',()=>{
  const {changes}=setup();
  fireEvent.change(select('Lyrics font'),{target:{value:'notoSerif'}});
  expect(changes.at(-1)).toEqual({roles:{lyrics:{font:'notoSerif'}}});
  fireEvent.change(select('Lyrics italic'),{target:{value:'on'}});fireEvent.change(select('Lyrics bold'),{target:{value:'off'}});
  const size=screen.getByLabelText('Lyrics size (%)');fireEvent.change(size,{target:{value:'150'}});fireEvent.blur(size);
  fireEvent.change(select('Markers font'),{target:{value:'notoSansMono'}});
  expect(changes.at(-1)).toEqual({roles:{lyrics:{font:'notoSerif',italic:true,bold:false,size:1.5},markers:{font:'notoSansMono'}}});
  fireEvent.change(select('Music font'),{target:{value:'petaluma'}});
  expect(changes.at(-1)).toEqual({music:'petaluma',roles:{lyrics:{font:'notoSerif',italic:true,bold:false,size:1.5},markers:{font:'notoSansMono'}}});
  fireEvent.change(select('Music font'),{target:{value:'bravura'}});
  expect('music' in changes.at(-1)!).toBe(false);
});

it('source_default_is_different_from_off_for_bold_and_italic',()=>{
  const {changes}=setup({value:{roles:{markers:{font:'notoSerif',bold:false}}}});
  // An explicit Off is shown as Off, not as the element default.
  expect(select('Markers bold')).toHaveValue('off');expect(select('Markers italic')).toHaveValue('inherit');
  fireEvent.change(select('Markers bold'),{target:{value:'inherit'}});
  expect(changes.at(-1)).toEqual({roles:{markers:{font:'notoSerif'}}});
  expect('bold' in changes.at(-1)!.roles!.markers!).toBe(false);
  fireEvent.change(select('Markers bold'),{target:{value:'off'}});
  expect(changes.at(-1)).toEqual({roles:{markers:{font:'notoSerif',bold:false}}});
});

it('removing_a_font_drops_its_flags_and_an_emptied_role_vanishes',()=>{
  const {changes}=setup({value:{roles:{lyrics:{font:'notoSerif',bold:true,italic:true,size:1.25},markers:{font:'notoSerif',bold:true}}}});
  fireEvent.change(select('Lyrics font'),{target:{value:'inherit'}});
  expect(changes.at(-1)).toEqual({roles:{lyrics:{size:1.25},markers:{font:'notoSerif',bold:true}}});
  fireEvent.change(select('Markers font'),{target:{value:'inherit'}});
  expect(changes.at(-1)).toEqual({roles:{lyrics:{size:1.25}}});
  const size=screen.getByLabelText('Lyrics size (%)');fireEvent.change(size,{target:{value:''}});fireEvent.blur(size);
  expect(changes.at(-1)).toEqual({});
});

it('switching_to_a_font_without_the_face_drops_italic',()=>{
  const {changes}=setup({value:{roles:{lyrics:{font:'notoSerif',italic:true,bold:true}}}});
  fireEvent.change(select('Lyrics font'),{target:{value:'notoSansMono'}});
  expect(changes.at(-1)).toEqual({roles:{lyrics:{font:'notoSansMono',bold:true}}});
  // Off is still a legal choice for a font without an italic face.
});

it('bold_italic_unavailable_until_font_chosen',()=>{
  const {changes}=setup();
  for(const name of ['Lyrics bold','Lyrics italic']){
    const control=select(name);
    expect(control).toHaveAttribute('aria-disabled','true');expect(control).not.toBeDisabled();expect(control).not.toHaveAttribute('disabled');
    expect(control.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(control.getAttribute('aria-describedby')!)).toHaveTextContent('Choose a font for Lyrics to set bold and italic.');
  }
  fireEvent.change(select('Lyrics bold'),{target:{value:'on'}});expect(changes).toEqual([]);expect(select('Lyrics bold')).toHaveValue('inherit');
  fireEvent.change(select('Lyrics font'),{target:{value:'notoSans'}});
  expect(select('Lyrics bold')).not.toHaveAttribute('aria-disabled');expect(select('Lyrics italic')).not.toHaveAttribute('aria-disabled');
  expect(screen.queryByText('Choose a font for Lyrics to set bold and italic.')).not.toBeInTheDocument();
  fireEvent.change(select('Lyrics bold'),{target:{value:'on'}});expect(changes.at(-1)).toEqual({roles:{lyrics:{font:'notoSans',bold:true}}});
});

it('mono_italic_unavailable_with_reason',()=>{
  const {changes}=setup({value:{roles:{staffText:{font:'notoSansMono'}}}});
  const italic=select('Staff text italic');
  expect(italic).toHaveAttribute('aria-disabled','true');expect(italic).not.toBeDisabled();
  expect(document.getElementById(italic.getAttribute('aria-describedby')!)).toHaveTextContent('Noto Sans Mono has no italic face, so italic is unavailable for Staff text.');
  fireEvent.change(italic,{target:{value:'on'}});expect(changes).toEqual([]);
  // Bold is still there.
  expect(select('Staff text bold')).not.toHaveAttribute('aria-disabled');
});

it('missing_glyph_warning_names_role_and_char',()=>{
  // The bundled faces cover Latin, Greek and Cyrillic, so a CJK lyric is what they lack.
  setup({value:{roles:{lyrics:{font:'notoSerif'},markers:{font:'notoSans'}}},texts:{lyrics:['la','中'],markers:['A']}});
  expect(screen.getByText('Noto Serif has no glyph for ‘中’ (Lyrics); it is drawn from the fallback font.')).toBeInTheDocument();
  expect(screen.queryByText(/Markers\)/)).not.toBeInTheDocument();
});

it('missing_glyph_warning_follows_the_choice_and_skips_roles_without_a_font',()=>{
  setup({texts:{lyrics:['中']}});
  expect(screen.queryByText(/has no glyph/)).not.toBeInTheDocument();
  fireEvent.change(select('Lyrics font'),{target:{value:'notoSansMono'}});
  expect(screen.getByText(/Noto Sans Mono has no glyph for ‘中’ \(Lyrics\)/)).toBeInTheDocument();
  fireEvent.change(select('Lyrics font'),{target:{value:'inherit'}});
  expect(screen.queryByText(/has no glyph/)).not.toBeInTheDocument();
});

it('substituted_music_symbols_count_shown',()=>{
  const view=setup({value:{music:'petaluma'},status:{failed:[],substituted:['a','b','c']}});
  expect(screen.getByText('3 music symbols are not in Petaluma and are drawn from Bravura.')).toBeInTheDocument();
  view.rerender({status:{failed:[],substituted:['a']}});
  expect(screen.getByText('1 music symbol is not in Petaluma and is drawn from Bravura.')).toBeInTheDocument();
  view.rerender({status:{failed:[],substituted:[]}});
  expect(screen.queryByText(/not in .* drawn from Bravura/)).not.toBeInTheDocument();
});

it('no_substitution_note_for_bravura',()=>{
  setup({status:{failed:[],substituted:['a']}});
  expect(screen.queryByText(/not in .* drawn from Bravura/)).not.toBeInTheDocument();
});

it('font_load_failure_shown',()=>{
  setup({status:{failed:['NotoSerif-Italic.ttf','Petaluma.otf','mystery.bin'],substituted:[]}});
  const note=screen.getByText(/A font could not be loaded/);
  // Plain names, not file names.
  expect(note).toHaveTextContent('Noto Serif Italic, Petaluma, mystery.bin');
  expect(note).not.toHaveTextContent('.ttf');
  expect(note).toHaveTextContent('fallback font');
});

it('no_status_notes_without_a_status_or_failures',()=>{
  setup({status:null});setup({status:{failed:[],substituted:[]}});
  expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
});

it('busy_keeps_focus_and_refuses_changes',()=>{
  const {changes,rerender}=setup({value:{roles:{lyrics:{font:'notoSerif'}}}});
  const font=select('Lyrics font');font.focus();expect(font).toHaveFocus();
  rerender({busy:true});
  expect(font).toHaveFocus();expect(font).toBeEnabled();expect(font).toHaveAttribute('aria-disabled','true');
  for(const control of document.querySelectorAll('select'))expect(control).not.toHaveAttribute('disabled');
  fireEvent.change(font,{target:{value:'notoSans'}});fireEvent.change(select('Music font'),{target:{value:'leland'}});fireEvent.change(select('Lyrics bold'),{target:{value:'on'}});
  expect(changes).toEqual([]);expect(font).toHaveValue('notoSerif');expect(select('Music font')).toHaveValue('bravura');
  const size=screen.getByLabelText('Lyrics size (%)');size.focus();fireEvent.change(size,{target:{value:'150'}});fireEvent.blur(size);
  expect(changes).toEqual([]);
  rerender({busy:false});
  fireEvent.change(font,{target:{value:'notoSans'}});expect(changes.at(-1)).toEqual({roles:{lyrics:{font:'notoSans'}}});
});

it('out_of_range_role_sizes_are_reported_by_role',()=>{
  const {changes,invalid}=setup();
  const lyrics=screen.getByLabelText('Lyrics size (%)'),tab=screen.getByLabelText('Tab numbers size (%)');
  fireEvent.change(lyrics,{target:{value:'250'}});fireEvent.blur(lyrics);
  fireEvent.change(tab,{target:{value:'70'}});fireEvent.blur(tab);
  expect(invalid).toEqual(['Lyrics size must be between 50% and 200%.','Tab numbers size must be between 75% and 150%.']);expect(changes).toEqual([]);
});
