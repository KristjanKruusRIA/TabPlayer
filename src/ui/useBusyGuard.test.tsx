// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { busyGuard } from './useBusyGuard';

describe('busyGuard', () => {
  afterEach(() => cleanup());

  it('allows activation when not busy and not disabled', async () => {
    const onClick = vi.fn();
    render(<button {...busyGuard({ onClick })}>Action</button>);
    const btn = screen.getByRole('button', { name: 'Action' });
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute('aria-disabled');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('keeps button focusable with aria-disabled and refuses activation when busy', async () => {
    const onClick = vi.fn();
    render(<button {...busyGuard({ busy: true, onClick })}>Action</button>);
    const btn = screen.getByRole('button', { name: 'Action' });
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    btn.focus();
    expect(btn).toHaveFocus();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    await userEvent.keyboard(' ');
    expect(onClick).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('sets disabled when disabled but not busy', async () => {
    const onClick = vi.fn();
    render(<button {...busyGuard({ disabled: true, onClick })}>Action</button>);
    const btn = screen.getByRole('button', { name: 'Action' });
    expect(btn).toBeDisabled();
  });

  it('never sets disabled attribute when busy even if also disabled', async () => {
    const onClick = vi.fn();
    render(<button {...busyGuard({ busy: true, disabled: true, onClick })}>Action</button>);
    const btn = screen.getByRole('button', { name: 'Action' });
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
