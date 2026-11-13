// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { HelpDialog } from './HelpDialog';

afterEach(cleanup);
const open = (initial: 'start' | 'editing' = 'start', section?: string) => {
  const onClose = vi.fn();
  render(<HelpDialog initial={initial} initialSection={section} onClose={onClose} />);
  return { onClose, search: screen.getByRole('searchbox', { name: 'Search help' }) as HTMLInputElement };
};
const type = (search: HTMLElement, value: string) => fireEvent.change(search, { target: { value } });
const live = () => document.querySelector('[aria-live="polite"]')!;

it('does not take the first focus from the topic list', () => {
  const { search } = open('editing');
  expect(screen.getByRole('button', { name: 'Editing the score' })).toHaveFocus();
  expect(search).not.toHaveFocus();
});

it('lists matching sections with the topic, the heading and an excerpt that shows the match', () => {
  const { search } = open();
  type(search, 'metronome');
  const results = screen.getByRole('list', { name: 'Search results' });
  const items = within(results).getAllByRole('button');
  expect(items.length).toBeGreaterThan(0);
  expect(items[0].textContent).toMatch(/metronome/i);
  expect(results.querySelector('mark')).not.toBeNull();
  expect(results.querySelector('mark')!.textContent!.toLowerCase()).toBe('metronome');
  expect(items[0].querySelector('.help-result-heading')!.textContent!.length).toBeGreaterThan(0);
  expect(screen.queryByRole('article')).toBeNull();
});

it('announces the number of results politely and keeps focus in the field', () => {
  const { search } = open();
  search.focus();
  type(search, 'metronome');
  expect(search).toHaveFocus();
  expect(live().textContent).toMatch(/^\d+ results\.$|^One result\.$/);
  type(search, 'metronome speed');
  expect(live().textContent).toMatch(/result/);
});

it('says plainly when nothing matches', () => {
  const { search } = open();
  type(search, 'zzzzqq');
  expect(screen.getByText(/No help topics match “zzzzqq”/)).toBeInTheDocument();
  expect(live().textContent).toMatch(/No help topics match “zzzzqq”/);
  expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull();
});

it('filters the topic list to the topics that have a match', () => {
  const { search } = open();
  const all = screen.getAllByRole('button').length;
  type(search, 'metronome');
  const nav = screen.getByRole('navigation');
  const shown = within(nav).getAllByRole('button');
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.length).toBeLessThan(all - 1);
});

it('opens the first result on Enter: topic, section heading, focus, and clears the search', () => {
  const { search } = open();
  type(search, 'speed');
  const first = within(screen.getByRole('list', { name: 'Search results' })).getAllByRole('button')[0];
  const heading = first.querySelector('.help-result-heading')!.textContent!;
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(search.value).toBe('');
  const opened = screen.getByRole('heading', { name: heading, level: 4 });
  expect(opened).toHaveFocus();
  expect(screen.getByRole('article')).toContainElement(opened);
  expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull();
});

it('opens a result when it is clicked', () => {
  const { search } = open();
  type(search, 'tuner');
  const items = within(screen.getByRole('list', { name: 'Search results' })).getAllByRole('button');
  const heading = items[items.length - 1].querySelector('.help-result-heading')!.textContent!;
  fireEvent.click(items[items.length - 1]);
  expect(screen.getByRole('heading', { name: heading, level: 4 })).toHaveFocus();
});

it('moves from the field to the first result with Down', () => {
  const { search } = open();
  type(search, 'metronome');
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  expect(within(screen.getByRole('list', { name: 'Search results' })).getAllByRole('button')[0]).toHaveFocus();
});

it('lets Escape clear the search before it closes the dialog', () => {
  const { search, onClose } = open();
  search.focus();
  type(search, 'metronome');
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(search.value).toBe('');
  expect(onClose).not.toHaveBeenCalled();
  expect(search).toHaveFocus();
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('clears the search with Escape from a result too', () => {
  const { search, onClose } = open();
  type(search, 'metronome');
  const first = within(screen.getByRole('list', { name: 'Search results' })).getAllByRole('button')[0];
  first.focus();
  fireEvent.keyDown(first, { key: 'Escape' });
  expect(search.value).toBe('');
  expect(onClose).not.toHaveBeenCalled();
});

it('does not search for one letter', () => {
  const { search } = open();
  type(search, 'm');
  expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull();
  expect(screen.getByRole('article')).toBeInTheDocument();
});

it('scrolls to the section named by context help without moving focus', () => {
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  open('start', 'help');
  expect(scroll).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Getting started' })).toHaveFocus();
});

it('does not swallow Escape when the field holds only spaces', () => {
  const { search, onClose } = open();
  search.focus();
  type(search, '   ');
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('does not search for single letters', () => {
  const { search } = open();
  type(search, 'a b');
  expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull();
  expect(live().textContent).toBe('');
  expect(screen.getByRole('article')).toBeInTheDocument();
});

it('shows a topic title match in the result and opens the topic at its first section', () => {
  const { search } = open();
  type(search, 'Exporting');
  const first = within(screen.getByRole('list', { name: 'Search results' })).getAllByRole('button')[0];
  expect(first.querySelector('.help-result-where mark')!.textContent).toBe('Exporting');
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(screen.getByRole('button', { name: 'Exporting' })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('heading', { name: 'Starting an export', level: 4 })).toHaveFocus();
});
