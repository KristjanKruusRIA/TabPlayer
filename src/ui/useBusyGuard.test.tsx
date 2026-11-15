// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { busyGuard, busyRegion, onRefusedSpace } from './useBusyGuard';

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

describe('busy keys', () => {
  afterEach(() => { cleanup(); onRefusedSpace(null); });
  it('hands a refused Space to the app, runs nothing of the control or its neighbours, and still refuses Enter', () => {
    const onClick = vi.fn(), neighbour = vi.fn(), app = vi.fn();
    onRefusedSpace(event => app(event.repeat));
    render(<div onKeyDown={event => neighbour(event.key)}><button {...busyGuard({ busy: true, onClick })}>Action</button></div>);
    const btn = screen.getByRole('button', { name: 'Action' });
    expect(fireEvent.keyDown(btn, { key: ' ' })).toBe(false);
    expect(app).toHaveBeenCalledOnce();
    expect(neighbour).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(btn, { key: 'Enter' })).toBe(false);
    expect(app).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
  });
  it('a busy region refuses Space for every control in it (a custom role=button too) and hands it to the app; a typed space is only refused', () => {
    const cell = vi.fn(), app = vi.fn();
    onRefusedSpace(() => app());
    render(<fieldset {...busyRegion(true)}><div role="button" tabIndex={0} onKeyDown={event => { if (event.key === ' ') cell(); }}>Cell</div><input aria-label="Text" /></fieldset>);
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Cell' }), { key: ' ' })).toBe(false);
    expect(cell).not.toHaveBeenCalled();
    expect(app).toHaveBeenCalledOnce();
    expect(fireEvent.keyDown(screen.getByLabelText('Text'), { key: ' ' })).toBe(false);
    expect(app).toHaveBeenCalledOnce();
  });
});
