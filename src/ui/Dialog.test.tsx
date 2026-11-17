// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Dialog } from './Dialog';

afterEach(cleanup);

const setup = () => {
  const onClose = vi.fn();
  const close = (event: React.KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key === 'Escape' && event.currentTarget.open) { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; }
  };
  render(<Dialog title="Sound" onClose={onClose}>
    <details open data-escape-closes onKeyDown={close} data-testid="inner"><summary>Keys</summary><input aria-label="Key" /></details>
    <details open><summary>Plain</summary><input aria-label="Other" /></details>
  </Dialog>);
  return { onClose, inner: screen.getByTestId('inner') as HTMLDetailsElement };
};

it('Escape inside an open section that closes itself on Escape closes that section and leaves the dialog open', () => {
  const { onClose, inner } = setup();
  screen.getByLabelText('Key').focus();
  fireEvent.keyDown(screen.getByLabelText('Key'), { key: 'Escape' });
  expect(inner.open).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
});

it('Escape elsewhere in the dialog closes the dialog, and so does a second Escape once the section is closed', () => {
  const { onClose, inner } = setup();
  fireEvent.keyDown(screen.getByLabelText('Other'), { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
  inner.open = false;
  fireEvent.keyDown(screen.getByText('Keys'), { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(2);
});
