// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { HelpDialog } from './HelpDialog';
import { appVersion,helpTopics,topicFor,updateStatus } from './help-topics';

afterEach(cleanup);

it('reports the same version as the native app and its crate',()=>{
  const tauri=JSON.parse(readFileSync('src-tauri/tauri.conf.json','utf8')),cargo=/^version\s*=\s*"([^"]+)"/m.exec(readFileSync('src-tauri/Cargo.toml','utf8'))?.[1];
  expect([tauri.version,cargo]).toEqual([appVersion,appVersion]);
  expect(updateStatus()).toBe(`You have TabPlayer ${appVersion}. This build has no update service, so it cannot check for newer versions. Install a newer build to update; your scores are not affected.`);
});

it('chooses the topic for the focused part of the window',()=>{
  document.body.innerHTML='<div class="document-tabs"><button id="tab">Score</button></div><header class="toolbar"><button id="file">Open</button></header><div class="transport"><button id="play">Play</button></div><section class="score-workspace" tabindex="0" id="score"></section><section class="workstation-left"><button id="track">Track</button></section><div class="workstation-inspector"><input id="field"></div><section class="workstation-dock"><button id="mute">Mute</button></section><p id="other"></p>';
  const at=(id:string)=>topicFor(document.getElementById(id));
  expect([at('tab'),at('file'),at('play'),at('score'),at('track'),at('field'),at('mute'),at('other'),topicFor(null)]).toEqual(['files','files','playback','editing','tracks','inspector','playback','start','start']);
  document.body.innerHTML='';
});

it('opens on the given topic, switches topics, discloses update status and keeps focus inside',()=>{
  const onClose=vi.fn();render(<HelpDialog initial="editing" onClose={onClose}/>);
  const topic=(name:string)=>screen.getByRole('button',{name});
  expect(topic('Editing the score')).toHaveFocus();expect(topic('Editing the score')).toHaveAttribute('aria-current','true');
  expect(screen.getByRole('article',{name:'Editing the score'})).toHaveTextContent('command palette');
  expect(screen.getAllByRole('button').map(button=>button.textContent)).toEqual(['Close',...helpTopics.map(entry=>entry.title)]);
  fireEvent.click(topic('About and updates'));
  expect(screen.getByRole('article',{name:'About and updates'})).toHaveTextContent(`TabPlayer ${appVersion} for desktop.`);
  expect(screen.getByRole('status')).toHaveTextContent('');
  fireEvent.click(topic('Check for updates'));
  expect(screen.getByRole('status')).toHaveTextContent(`You have TabPlayer ${appVersion}. This build has no update service`);
  const close=topic('Close'),check=topic('Check for updates');check.focus();
  fireEvent.keyDown(check,{key:'Tab'});expect(close).toHaveFocus();
  fireEvent.keyDown(close,{key:'Tab',shiftKey:true});expect(check).toHaveFocus();
  fireEvent.keyDown(check,{key:'Escape'});expect(onClose).toHaveBeenCalled();
});
