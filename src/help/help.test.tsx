// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { HelpDialog } from './HelpDialog';
import { appVersion,getHelpTopics,helpTopics,topicFor,updateStatus } from './help-topics';
import { en as enMessages } from '../i18n/en';
import { et as etMessages } from '../i18n/et';
import { de as deMessages } from '../i18n/de';

afterEach(cleanup);

it('reports the same version as the native app and its crate',()=>{
  const tauri=JSON.parse(readFileSync('src-tauri/tauri.conf.json','utf8')),cargo=/^version\s*=\s*"([^"]+)"/m.exec(readFileSync('src-tauri/Cargo.toml','utf8'))?.[1];
  expect([tauri.version,cargo]).toEqual([appVersion,appVersion]);
  expect(updateStatus()).toBe(`You have TabPlayer ${appVersion}. This release has no update service. To update, install a newer version; your scores are not affected.`);
});

it('chooses the topic for the focused part of the window',()=>{
  document.body.innerHTML='<div class="document-tabs"><button id="tab">Score</button></div><header class="toolbar"><button id="file">Open</button></header><div class="transport"><button id="play">Play</button></div><section class="score-workspace" tabindex="0" id="score"></section><div class="workstation-inspector"><div role="tabpanel" id="inspector-panel-track"><button id="track">Track</button></div><input id="field"></div><section class="workstation-dock"><button id="mute">Mute</button></section><p id="other"></p>';
  const at=(id:string)=>topicFor(document.getElementById(id));
  expect([at('tab'),at('file'),at('play'),at('score'),at('track'),at('field'),at('mute'),at('other'),topicFor(null)]).toEqual(['files','files','playback','editing','tracks','inspector','playback','start','start']);
  document.body.innerHTML='';
});

it('explains the Mixer and Sound views from their own controls',()=>{
  document.body.innerHTML='<section class="mixer-view"><button id="mix">Mute</button></section><section class="sound-view"><button id="rig">Hear</button></section>';
  expect([topicFor(document.getElementById('mix')),topicFor(document.getElementById('rig'))]).toEqual(['playback','tracks']);
  document.body.innerHTML='';
});

it('opens on the given topic, switches topics, discloses update status and keeps focus inside',()=>{
  const onClose=vi.fn();render(<HelpDialog initial="editing" onClose={onClose}/>);
  const topic=(name:string)=>screen.getByRole('button',{name});
  expect(topic('Editing the score')).toHaveFocus();expect(topic('Editing the score')).toHaveAttribute('aria-current','true');
  expect(screen.getByRole('article',{name:'Editing the score'})).toHaveTextContent('command palette');
  expect(screen.getAllByRole('button').map(button=>button.getAttribute('aria-label')??button.textContent)).toEqual(['Close',...helpTopics.map(entry=>entry.title)]);
  fireEvent.click(topic('About and updates'));
  expect(screen.getByRole('article',{name:'About and updates'})).toHaveTextContent(`TabPlayer ${appVersion} for desktop.`);
  expect(screen.getByRole('status')).toHaveTextContent('');
  fireEvent.click(topic('Check for updates'));
  expect(screen.getByRole('status')).toHaveTextContent(`You have TabPlayer ${appVersion}. This release has no update service`);
  const close=topic('Close'),check=topic('Check for updates');check.focus();
  fireEvent.keyDown(check,{key:'Tab'});expect(close).toHaveFocus();
  fireEvent.keyDown(close,{key:'Tab',shiftKey:true});expect(check).toHaveFocus();
  fireEvent.keyDown(check,{key:'Escape'});expect(onClose).toHaveBeenCalled();
});

it('closes when the backdrop is pressed but not when the panel is',()=>{
  const onClose=vi.fn();render(<HelpDialog initial="editing" onClose={onClose}/>);
  fireEvent.mouseDown(screen.getByRole('dialog'));expect(onClose).not.toHaveBeenCalled();
  fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);expect(onClose).toHaveBeenCalledTimes(1);
});

it('describes the inspector tabs and the Track tab, not the old Track task',()=>{
  const {unmount}=render(<HelpDialog initial="tracks" onClose={vi.fn()}/>);
  const tracks=screen.getByRole('article',{name:'Tracks and sounds'});
  expect(tracks).toHaveTextContent('The Track tab of the inspector');expect(tracks).toHaveTextContent('Keep pitch');expect(tracks).not.toHaveTextContent('Track task');
  unmount();render(<HelpDialog initial="inspector" onClose={vi.fn()}/>);
  const inspector=screen.getByRole('article',{name:'The inspector'});
  expect(inspector).toHaveTextContent('three tabs');expect(inspector).toHaveTextContent('Song holds');expect(inspector).toHaveTextContent('Track holds');expect(inspector).toHaveTextContent('Selection holds');expect(inspector).toHaveTextContent('Practice settings on the toolbar');
});

it('documents the Shift+L, [ and ] practice shortcuts in the shortcuts topic in every language',()=>{
  const lines=(table:Record<string,string>)=>getHelpTopics(key=>table[key]).find(topic=>topic.id==='shortcuts')!.paragraphs;
  const [en,et,de]=[enMessages,etMessages,deMessages].map(table=>lines(table as Record<string,string>).find(line=>line.includes('Shift + L'))!);
  for(const line of [en,et,de])expect(line).toContain('[');
  expect(new Set([en,et,de]).size).toBe(3);
  expect(helpTopics.find(topic=>topic.id==='shortcuts')!.paragraphs).toContain(en);
});
