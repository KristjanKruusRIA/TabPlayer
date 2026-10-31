// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import { soundPreset } from '../audio/sound-model';
import { SoundRig } from './SoundRig';

afterEach(() => { cleanup(); localStorage.clear(); });
const css = readFileSync(resolve(process.cwd(), 'src/rig/rig.css'), 'utf8');
/** The declarations of every rule whose selector list has a part ending in `selector`, in file order (at-rule wrappers are not told apart). */
const rules = (selector: string) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(match => match[1].split(',').some(part => part.trim().endsWith(selector))).map(match => match[2]).join(';');
const tracks = [{ id: 'guitar', name: 'Lead Guitar', program: 29 }, { id: 'drums', name: 'Drums', program: 0, percussion: true }];
function mount(first = 'drums') {
  function Host() {
    const [track, setTrack] = useState(first);
    return <SoundRig trackId={track} sound={soundPreset('gm')} tracks={tracks} onTrack={setTrack} onEdit={() => {}} />;
  }
  render(<Host />);
}
const help = () => screen.getByRole('button', { name: 'Which hits differ' });
const table = () => document.querySelector('.rig-kit-table');

it('labels the drum kit select with visible text, not text clipped for screen readers only', () => {
  mount();
  const select = screen.getByLabelText('Drum kit');
  const name = select.closest('label')!.querySelector('.rig-kit-name');
  expect(name).toHaveTextContent('Drum kit');
  expect(name!.closest('.rig-visually-hidden')).toBeNull();
  expect(rules('.rig-kit-name')).not.toMatch(/clip|position:\s*absolute|width:\s*1px/);
  expect(rules('.rig-kit-label')).not.toMatch(/clip|position:\s*absolute|width:\s*1px/);
});

it('opens the kit table inside the kit box, under its button, and not at a fixed place on the window', async () => {
  mount();
  expect(table()).toBeNull();
  await userEvent.click(help());
  expect(help()).toHaveAttribute('aria-expanded', 'true');
  const box = help().closest('.rig-drum-kit')!;
  expect(box.contains(table())).toBe(true);
  const rule = rules('.rig-kit-table');
  expect(rule).toMatch(/position:\s*absolute/);
  expect(rule).toMatch(/top:\s*calc\(100%/);
  expect(rule).toMatch(/right:\s*0/);
  expect(rule).not.toMatch(/position:\s*fixed|left:/);
  expect(rules('.rig-drum-kit')).toMatch(/position:\s*relative/);
});

it('closes the kit table on a press outside it, but not on a press inside it', async () => {
  mount();
  await userEvent.click(help());
  await userEvent.click(within(table() as HTMLElement).getByText(/Every drum key has its own sound/));
  expect(table()).not.toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: /^Amp, / }));
  expect(table()).toBeNull();
  await userEvent.click(help());
  await userEvent.click(document.body);
  expect(table()).toBeNull();
  await userEvent.click(help());
  await userEvent.click(help());
  expect(table()).toBeNull();
});

it('closes the kit table on Escape wherever focus is, including after a click on its text, and returns focus to its button', async () => {
  mount();
  await userEvent.click(help());
  await userEvent.click(within(table() as HTMLElement).getByText(/Every drum key has its own sound/));
  expect(document.activeElement).not.toBe(help());
  await userEvent.keyboard('{Escape}');
  expect(table()).toBeNull();
  expect(document.activeElement).toBe(help());
  await userEvent.click(help());
  screen.getByLabelText('Drum kit').focus();
  await userEvent.keyboard('{Escape}');
  expect(table()).toBeNull();
});

it('closes the kit table when focus moves outside it', async () => {
  mount();
  await userEvent.click(help());
  act(() => { screen.getByRole('tab', { name: /^Amp, / }).focus(); });
  expect(table()).toBeNull();
});

it('keeps the kit slot in the head for a pitched track, so changing track moves nothing', async () => {
  mount('guitar');
  const head = document.querySelector('.rig-head')!;
  const slot = () => [...head.children].findIndex(child => child.classList.contains('rig-drum-kit'));
  expect(slot()).toBeGreaterThan(0);
  const before = slot(), count = head.children.length;
  expect(head.children[before]).toHaveAttribute('aria-hidden', 'true');
  expect(screen.queryByLabelText('Drum kit')).toBeNull();
  await userEvent.click(screen.getByRole('radio', { name: 'Drums' }));
  expect(screen.getByLabelText('Drum kit')).toBeInTheDocument();
  expect(slot()).toBe(before);
  expect(head.children).toHaveLength(count);
  expect(rules('.rig-drum-kit-reserve')).toMatch(/visibility:\s*hidden/);
});

it('lays the sound lock out as a row and keeps the head groups, and the stage title row, one height at any width in a short window', () => {
  expect(rules('.rig-lock')).toMatch(/flex-direction:\s*row/);
  // Short window rules: every head group has the same height and the stage title row never wraps, so no row appears or goes as the width changes.
  const start = css.indexOf('/* A short window: the stage wins.'), short = css.slice(start, css.indexOf('/* With room across', start));
  expect(start).toBeGreaterThan(0);
  expect(short).toMatch(/\.rig-head>:is\([^)]*\.rig-tracks[^)]*\.rig-source-picker[^)]*\.rig-presets[^)]*\.rig-lock[^)]*\.rig-drum-kit[^)]*\)\s*\{\s*min-height:\s*30px/);
  expect(short).toMatch(/\.rig-stage-head\s*\{\s*flex-wrap:\s*nowrap/);
  expect(short).toMatch(/\.rig-stage-head \.tp-segmented\s*\{\s*flex-wrap:\s*nowrap/);
  expect(short).toMatch(/\.rig-stage-actions\s*\{\s*flex-wrap:\s*nowrap/);
  expect(short).toMatch(/\.rig-main\s*\{[^}]*padding-bottom:\s*4px/);
});
