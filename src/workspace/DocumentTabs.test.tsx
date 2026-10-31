// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { DocumentTabs } from './DocumentTabs';
import type { DocumentTab } from './types';

afterEach(cleanup);
const tabs:DocumentTab[]=[
  {id:'first',title:'Untitled',path:null,dirty:true},
  {id:'second',title:'Untitled',path:'C:/scores/second.tabplayer',dirty:false},
  {id:'third',title:'夜の音楽 — '+ 'Long score title '.repeat(12),path:'C:/scores/夜.tabplayer',dirty:false}
];

it('tabs_disambiguate_duplicates_and_keep_close_separate',()=>{
  const onActivate=vi.fn(),onClose=vi.fn();
  render(<DocumentTabs tabs={tabs} activeId="first" disabled={false} onActivate={onActivate} onClose={onClose}/>);
  expect(screen.getByRole('tablist',{name:'Open scores'})).toBeInTheDocument();
  const items=screen.getAllByRole('tab'),close=screen.getAllByRole('button');
  expect(new Set(items.map(item=>item.getAttribute('aria-label'))).size).toBe(3);
  expect(new Set(close.map(item=>item.getAttribute('aria-label'))).size).toBe(3);
  expect(items[0]).toHaveAccessibleDescription('Unsaved score; Unsaved changes');
  expect(items[1]).toHaveAccessibleDescription('C:/scores/second.tabplayer');
  expect(items[2]).toHaveAccessibleName(`Score 3 of 3: ${tabs[2].title.trim()}`);
  expect(items[2]).toHaveAttribute('title',tabs[2].path);
  expect(items[0]).toHaveAttribute('aria-selected','true');
  expect(items[0]).toHaveAttribute('aria-controls','document-panel-first');
  expect(items[0]).toHaveAttribute('id','document-tab-first');
  expect(document.querySelector('button button')).toBeNull();
  fireEvent.click(close[1]);expect(onClose).toHaveBeenCalledExactlyOnceWith('second');expect(onActivate).not.toHaveBeenCalled();
  fireEvent.click(items[2]);expect(onActivate).toHaveBeenCalledExactlyOnceWith('third');
  expect(items[0]).toHaveAttribute('aria-selected','true');expect(items[2]).toHaveAttribute('aria-selected','false');
});

it('manual_keyboard_activation_and_busy_are_controlled',async()=>{
  const user=userEvent.setup(),onActivate=vi.fn(),onClose=vi.fn();
  const scroll=vi.fn();Element.prototype.scrollIntoView=scroll;
  const props={tabs,activeId:'first',disabled:false,onActivate,onClose};
  const view=render(<><input aria-label="Elsewhere"/><DocumentTabs {...props}/></>);
  const items=screen.getAllByRole('tab');
  expect(items.map(item=>item.tabIndex)).toEqual([0,-1,-1]);
  items[0].focus();await user.keyboard('{ArrowRight}');expect(items[1]).toHaveFocus();
  expect(onActivate).not.toHaveBeenCalled();expect(items[0]).toHaveAttribute('aria-selected','true');
  await user.keyboard('{End}');expect(items[2]).toHaveFocus();
  await user.keyboard('{ArrowRight}');expect(items[0]).toHaveFocus();
  await user.keyboard('{ArrowLeft}');expect(items[2]).toHaveFocus();
  await user.keyboard('{Home}');expect(items[0]).toHaveFocus();
  await user.keyboard('{ArrowRight}{Enter} ');expect(onActivate.mock.calls).toEqual([['second'],['second']]);
  expect(scroll).toHaveBeenLastCalledWith({block:'nearest',inline:'nearest'});
  view.rerender(<><input aria-label="Elsewhere"/><DocumentTabs {...props} activeId="second"/></>);
  expect(items[1]).toHaveAttribute('aria-selected','true');
  screen.getByLabelText('Elsewhere').focus();scroll.mockClear();
  view.rerender(<><input aria-label="Elsewhere"/><DocumentTabs {...props} activeId="third"/></>);
  expect(screen.getByLabelText('Elsewhere')).toHaveFocus();expect(scroll).toHaveBeenCalled();
  scroll.mockClear();view.rerender(<><input aria-label="Elsewhere"/><DocumentTabs {...props} activeId="third" tabs={[...tabs]}/></>);
  expect(scroll).not.toHaveBeenCalled();expect(screen.getByLabelText('Elsewhere')).toHaveFocus();
  onActivate.mockClear();view.rerender(<DocumentTabs {...props} disabled/>);
  screen.getAllByRole('tab').forEach(item=>{expect(item).toBeDisabled();fireEvent.click(item);fireEvent.keyDown(item,{key:'Enter'});});
  screen.getAllByRole('button').forEach(item=>{expect(item).toBeDisabled();fireEvent.click(item);});
  expect(onActivate).not.toHaveBeenCalled();expect(onClose).not.toHaveBeenCalled();
});

it('keeps a reachable focus stop after closing a focused score and uses Untitled fallback',()=>{
  const scroll=vi.fn();Element.prototype.scrollIntoView=scroll;
  const props={disabled:false,onActivate:vi.fn(),onClose:vi.fn()};
  const view=render(<DocumentTabs {...props} tabs={tabs} activeId="second"/>);
  screen.getAllByRole('tab')[1].focus();
  view.rerender(<DocumentTabs {...props} tabs={[tabs[0],tabs[2]]} activeId="third"/>);
  expect(screen.getAllByRole('tab')[1]).toHaveFocus();
  view.rerender(<DocumentTabs {...props} tabs={[{...tabs[0],title:''}]} activeId="first"/>);
  expect(screen.getByRole('tab',{name:'Score 1 of 1: Untitled'})).toHaveFocus();
  expect(screen.getByRole('tab')).toHaveAttribute('tabindex','0');
});

it.each([
  ['Untitled','Untitled','Untitled, score 1 of 3'],
  ['Untitled',' Untitled ','\tUntitled\n']
])('keeps final accessible names unique for adversarial titles: %j',(first,second,third)=>{
  const titles=[first,second,third];
  render(<DocumentTabs tabs={tabs.map((tab,index)=>({...tab,title:titles[index]}))} activeId="first" disabled={false} onActivate={vi.fn()} onClose={vi.fn()}/>);
  for(const role of ['tab','button']){
    for(const item of screen.getAllByRole(role)){
      const exposedName=item.getAttribute('aria-label')!.trim().replace(/\s+/g,' ');
      expect(screen.getAllByRole(role,{name:exposedName})).toHaveLength(1);
    }
  }
  expect(Array.from(document.querySelectorAll('.document-tab-title'),item=>item.textContent)).toEqual(titles);
});

it('marks a finalized tab with an accessible lock',()=>{
  render(<DocumentTabs tabs={[{id:'locked',title:'Etude',path:'C:/scores/etude.tabplayer',dirty:false,locked:true},{id:'open',title:'Open',path:null,dirty:false}]} activeId="locked" disabled={false} onActivate={vi.fn()} onClose={vi.fn()}/>);
  const [locked,open]=screen.getAllByRole('tab');
  expect(locked.querySelector('svg[aria-label="Finalized"]')).not.toBeNull();expect(open.querySelector('svg[aria-label="Finalized"]')).toBeNull();
  expect(locked).toHaveAccessibleDescription('C:/scores/etude.tabplayer; Finalized');
});
