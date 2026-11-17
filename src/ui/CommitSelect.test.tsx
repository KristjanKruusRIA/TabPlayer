// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CommitSelect } from './CommitSelect';

afterEach(cleanup);
const setup = (value = 'a') => {
  const onCommit = vi.fn();
  const view = render(<label>Pick<CommitSelect value={value} onCommit={onCommit}><option value="a">A</option><option value="b">B</option><option value="c">C</option></CommitSelect></label>);
  return { onCommit, view, select: screen.getByLabelText('Pick') as HTMLSelectElement };
};
/** A key press on a closed select: the browser changes the value between key down and key up. */
const press = (select: HTMLSelectElement, key: string, value: string) => { fireEvent.keyDown(select, { key });fireEvent.change(select, { target: { value } });fireEvent.keyUp(select, { key }); };

it('a choice made with the pointer is recorded at once', () => {
  const { onCommit, select } = setup();
  fireEvent.change(select, { target: { value: 'b' } });
  expect(onCommit).toHaveBeenCalledTimes(1);expect(onCommit).toHaveBeenLastCalledWith('b');
});

it('browsing a closed select with the arrow keys records nothing per key press, and one edit when the select is left', () => {
  const { onCommit, select } = setup();
  select.focus();
  press(select, 'ArrowDown', 'b');press(select, 'ArrowDown', 'c');press(select, 'ArrowUp', 'b');
  expect(onCommit).not.toHaveBeenCalled();expect(select).toHaveValue('b');
  fireEvent.blur(select);
  expect(onCommit).toHaveBeenCalledTimes(1);expect(onCommit).toHaveBeenLastCalledWith('b');
});

it('Enter records the browsed choice once, and browsing back to the recorded value records nothing', () => {
  const { onCommit, select } = setup();
  press(select, 'ArrowDown', 'b');fireEvent.keyDown(select, { key: 'Enter' });
  expect(onCommit).toHaveBeenCalledTimes(1);expect(onCommit).toHaveBeenLastCalledWith('b');
  cleanup();
  const again = setup();
  press(again.select, 'ArrowDown', 'b');press(again.select, 'ArrowUp', 'a');fireEvent.blur(again.select);
  expect(again.onCommit).not.toHaveBeenCalled();
});

it('Escape puts the recorded value back, and a pointer choice after browsing is recorded at once', () => {
  const { onCommit, select } = setup();
  press(select, 'ArrowDown', 'c');fireEvent.keyDown(select, { key: 'Escape' });
  expect(select).toHaveValue('a');fireEvent.blur(select);expect(onCommit).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: 'b' } });
  expect(onCommit).toHaveBeenCalledTimes(1);
});

it('type-ahead letters and digits are browsing: one edit on blur, one on Enter, none when the final value is the start', () => {
  const { onCommit, select } = setup();
  press(select, 'b', 'b');press(select, 'c', 'c');press(select, 'b', 'b');press(select, '2', 'c');
  expect(onCommit).not.toHaveBeenCalled();expect(select).toHaveValue('c');
  fireEvent.blur(select);
  expect(onCommit).toHaveBeenCalledTimes(1);expect(onCommit).toHaveBeenLastCalledWith('c');
  cleanup();
  const entered = setup();
  press(entered.select, 'b', 'b');fireEvent.keyDown(entered.select, { key: 'Enter' });
  expect(entered.onCommit).toHaveBeenCalledTimes(1);expect(entered.onCommit).toHaveBeenLastCalledWith('b');
  cleanup();
  const back = setup();
  press(back.select, 'b', 'b');press(back.select, 'a', 'a');fireEvent.blur(back.select);
  expect(back.onCommit).not.toHaveBeenCalled();
  fireEvent.change(back.select, { target: { value: 'c' } });
  expect(back.onCommit).toHaveBeenCalledTimes(1);
});

it('follows the value it is given', () => {
  const { select, view, onCommit } = setup();
  press(select, 'ArrowDown', 'b');
  view.rerender(<label>Pick<CommitSelect value="c" onCommit={onCommit}><option value="a">A</option><option value="b">B</option><option value="c">C</option></CommitSelect></label>);
  expect(screen.getByLabelText('Pick')).toHaveValue('c');
});
