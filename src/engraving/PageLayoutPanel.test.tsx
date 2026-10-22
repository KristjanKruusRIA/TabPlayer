// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PageLayoutPanel } from './PageLayoutPanel';
import type { EngravingCommand,PageLayout } from './types';

type PageCommand=Extract<EngravingCommand,{type:'setPageLayout'}>;
const page=():PageLayout=>({widthMm:180,heightMm:240,marginsMm:{top:10,right:12,bottom:14,left:16},scale:1,profile:'document'});
afterEach(cleanup);

it('edits independent physical fields and emits one exact detached page command on Apply',()=>{
  const value=page(),commands:PageCommand[]=[];
  render(<PageLayoutPanel value={value} busy={false} onEdit={command=>commands.push(command)}/>);
  expect(screen.getByLabelText('Width (mm)')).toHaveValue(180);expect(screen.getByLabelText('Height (mm)')).toHaveValue(240);
  expect(screen.getByLabelText('Scale (%)')).toHaveValue(100);expect(screen.getByLabelText('PDF notation')).toHaveValue('document');
  for(const [label,number] of [['Width (mm)','190.5'],['Height (mm)','250.25'],['Top margin (mm)','1'],['Right margin (mm)','2'],['Bottom margin (mm)','3'],['Left margin (mm)','4'],['Scale (%)','125.5']])fireEvent.change(screen.getByLabelText(label),{target:{value:number}});
  fireEvent.change(screen.getByLabelText('PDF notation'),{target:{value:'ScoreTab'}});expect(commands).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));
  expect(commands).toEqual([{type:'setPageLayout',layout:{widthMm:190.5,heightMm:250.25,marginsMm:{top:1,right:2,bottom:3,left:4},scale:1.255,profile:'ScoreTab'}}]);
  fireEvent.change(screen.getByLabelText('Left margin (mm)'),{target:{value:'5'}});
  expect(commands[0].layout.marginsMm.left).toBe(4);expect(value).toEqual(page());
});

it.each([['A3',297,420],['A4',210,297],['A5',148,210],['Letter',215.9,279.4],['Legal',215.9,355.6]] as const)('%s preset changes dimensions only',(name,widthMm,heightMm)=>{
  const commands:PageCommand[]=[];
  render(<PageLayoutPanel value={{...page(),scale:1.5,profile:'Tab'}} busy={false} onEdit={command=>commands.push(command)}/>);
  fireEvent.click(screen.getByRole('button',{name}));
  expect(screen.getByLabelText('Width (mm)')).toHaveValue(widthMm);expect(screen.getByLabelText('Height (mm)')).toHaveValue(heightMm);
  expect(screen.getByLabelText('Left margin (mm)')).toHaveValue(16);expect(screen.getByLabelText('Scale (%)')).toHaveValue(150);
  expect(screen.getByLabelText('PDF notation')).toHaveValue('Tab');expect(commands).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));
  expect(commands).toEqual([{type:'setPageLayout',layout:{widthMm,heightMm,marginsMm:{top:10,right:12,bottom:14,left:16},scale:1.5,profile:'Tab'}}]);
});

it('swaps final dimensions without rotating independent margins or applying early',()=>{
  const commands:PageCommand[]=[];
  render(<PageLayoutPanel value={page()} busy={false} onEdit={command=>commands.push(command)}/>);
  fireEvent.click(screen.getByRole('button',{name:'Swap orientation'}));
  expect(screen.getByLabelText('Width (mm)')).toHaveValue(240);expect(screen.getByLabelText('Height (mm)')).toHaveValue(180);expect(commands).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));
  expect(commands).toEqual([{type:'setPageLayout',layout:{widthMm:240,heightMm:180,marginsMm:{top:10,right:12,bottom:14,left:16},scale:1,profile:'document'}}]);
});

it.each([
  ['Width (mm)',''],['Width (mm)','19'],['Height (mm)','1001'],
  ['Top margin (mm)',''],['Right margin (mm)','-1'],['Bottom margin (mm)','220'],['Left margin (mm)','170'],
  ['Scale (%)',''],['Scale (%)','24.9'],['Scale (%)','300.1']
])('rejects invalid %s=%s without changing the applied page',(label,number)=>{
  const value=page(),commands:PageCommand[]=[];
  render(<PageLayoutPanel value={value} busy={false} onEdit={command=>commands.push(command)}/>);
  fireEvent.change(screen.getByLabelText(label),{target:{value:number}});
  fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));
  expect(screen.getByRole('alert')).toHaveTextContent(/width|height|margin|scale/i);expect(commands).toEqual([]);expect(value).toEqual(page());
});

it('resets drafts and validation on applied value changes, and disables every control while busy',()=>{
  const commands:PageCommand[]=[],props={value:page(),busy:false,onEdit:(command:PageCommand)=>commands.push(command)},view=render(<PageLayoutPanel {...props}/>);
  fireEvent.change(screen.getByLabelText('Width (mm)'),{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));expect(screen.getByRole('alert')).toBeInTheDocument();
  view.rerender(<PageLayoutPanel {...props} value={{widthMm:215.9,heightMm:355.6,marginsMm:{top:20,right:21,bottom:22,left:23},scale:0.75,profile:'Score'}}/>);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(screen.getByLabelText('Width (mm)')).toHaveValue(215.9);expect(screen.getByLabelText('Height (mm)')).toHaveValue(355.6);
  expect(screen.getByLabelText('Top margin (mm)')).toHaveValue(20);expect(screen.getByLabelText('Left margin (mm)')).toHaveValue(23);expect(screen.getByLabelText('Scale (%)')).toHaveValue(75);expect(screen.getByLabelText('PDF notation')).toHaveValue('Score');
  view.rerender(<PageLayoutPanel {...props} busy/>);
  for(const element of [...screen.getAllByRole('spinbutton'),...screen.getAllByRole('button'),screen.getByRole('combobox')])expect(element).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));expect(commands).toEqual([]);
});

it('keeps drafts and validation through equivalent detached applied values and status rerenders',()=>{
  const props={value:page(),busy:false,onEdit:()=>{}},view=render(<PageLayoutPanel {...props}/>);
  fireEvent.change(screen.getByLabelText('Width (mm)'),{target:{value:'190'}});
  fireEvent.change(screen.getByLabelText('Top margin (mm)'),{target:{value:'20'}});
  fireEvent.change(screen.getByLabelText('Scale (%)'),{target:{value:'125'}});
  fireEvent.change(screen.getByLabelText('PDF notation'),{target:{value:'Tab'}});
  view.rerender(<PageLayoutPanel {...props} value={structuredClone(props.value)} busy/>);
  view.rerender(<PageLayoutPanel {...props} value={structuredClone(props.value)} onEdit={()=>{}}/>);
  expect(screen.getByLabelText('Width (mm)')).toHaveValue(190);expect(screen.getByLabelText('Top margin (mm)')).toHaveValue(20);
  expect(screen.getByLabelText('Scale (%)')).toHaveValue(125);expect(screen.getByLabelText('PDF notation')).toHaveValue('Tab');
  fireEvent.change(screen.getByLabelText('Width (mm)'),{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));
  view.rerender(<PageLayoutPanel {...props} value={structuredClone(props.value)}/>);
  expect(screen.getByLabelText('Width (mm)')).toHaveValue(null);expect(screen.getByRole('alert')).toBeInTheDocument();
});

it.each([
  {...page(),widthMm:181},{...page(),heightMm:241},{...page(),scale:1.5},{...page(),profile:'Score' as const},
  ...(['top','right','bottom','left'] as const).map(side=>({...page(),marginsMm:{...page().marginsMm,[side]:25}}))
])('resets the complete draft when applied scalar %# changes',(value)=>{
  const props={value:page(),busy:false,onEdit:()=>{}},view=render(<PageLayoutPanel {...props}/>);
  fireEvent.change(screen.getByLabelText('Width (mm)'),{target:{value:'190'}});fireEvent.change(screen.getByLabelText('Scale (%)'),{target:{value:'125'}});
  view.rerender(<PageLayoutPanel {...props} value={value}/>);
  expect(screen.getByLabelText('Width (mm)')).toHaveValue(value.widthMm);expect(screen.getByLabelText('Scale (%)')).toHaveValue(value.scale*100);
});

it('accepts fractional scale boundaries and clears a corrected validation error',()=>{
  const commands:PageCommand[]=[];
  render(<PageLayoutPanel value={page()} busy={false} onEdit={command=>commands.push(command)}/>);
  fireEvent.change(screen.getByLabelText('Scale (%)'),{target:{value:'0'}});fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));expect(screen.getByRole('alert')).toBeInTheDocument();
  for(const scale of ['25','100.5','300']){fireEvent.change(screen.getByLabelText('Scale (%)'),{target:{value:scale}});fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));}
  expect(commands.map(command=>command.layout.scale)).toEqual([0.25,1.005,3]);expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('edits first-page and other-page header and footer fields, keeping the default shape unless they change',()=>{
  const commands:PageCommand[]=[];
  render(<PageLayoutPanel value={page()} busy={false} onEdit={command=>commands.push(command)}/>);
  expect(screen.getByLabelText('First page header left')).toHaveValue('%TITLE%');expect(screen.getByLabelText('Other pages footer center')).toHaveValue('%PAGE% / %PAGES%');
  expect(screen.getByText(/%ARTIST%/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));expect(commands.at(-1)!.layout).toEqual(page());
  fireEvent.change(screen.getByLabelText('First page header right'),{target:{value:'%ARTIST%'}});
  fireEvent.change(screen.getByLabelText('Other pages header left'),{target:{value:''}});
  fireEvent.change(screen.getByLabelText('Other pages footer right'),{target:{value:'%TITLE% %PAGE%'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));
  expect(commands.at(-1)!.layout).toEqual({...page(),headerFooter:{
    first:{header:{left:'%TITLE%',center:'',right:'%ARTIST%'},footer:{left:'',center:'%PAGE% / %PAGES%',right:''}},
    other:{header:{left:'',center:'',right:''},footer:{left:'',center:'%PAGE% / %PAGES%',right:'%TITLE% %PAGE%'}},
  }});
  fireEvent.click(screen.getByRole('button',{name:'Default header and footer'}));
  expect(screen.getByLabelText('First page header right')).toHaveValue('');
  fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));expect(commands.at(-1)!.layout).toEqual(page());
});

it('shows a saved header and footer and refuses unknown fields',()=>{
  const value={...page(),headerFooter:{first:{header:{left:'%SUBTITLE%',center:'',right:''},footer:{left:'',center:'',right:''}},other:{header:{left:'',center:'',right:''},footer:{left:'%PAGE%',center:'',right:''}}}};
  const commands:PageCommand[]=[];
  render(<PageLayoutPanel value={value} busy={false} onEdit={command=>commands.push(command)}/>);
  expect(screen.getByLabelText('First page header left')).toHaveValue('%SUBTITLE%');expect(screen.getByLabelText('Other pages footer left')).toHaveValue('%PAGE%');
  fireEvent.change(screen.getByLabelText('Width (mm)'),{target:{value:'200'}});fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));
  expect(commands.at(-1)!.layout).toEqual({...value,widthMm:200});
  fireEvent.change(screen.getByLabelText('First page footer center'),{target:{value:'%COMPOSER%'}});fireEvent.click(screen.getByRole('button',{name:'Apply page layout'}));
  expect(screen.getByRole('alert')).toHaveTextContent('First page footer center: unknown field %COMPOSER%.');expect(commands).toHaveLength(1);
});
