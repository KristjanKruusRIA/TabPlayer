import { describe, expect, it } from 'vitest';
import { gp8CursorTarget, gp8Key } from './gp8-keys';

const key = (name: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => gp8Key({ key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('GP8 keys', () => {
  it('names each key and leaves Del alone', () => {
    expect(key('Backspace')).toEqual({ kind: 'edit', edit: 'removeNote' });
    expect(key('Delete', { shiftKey: true })).toEqual({ kind: 'edit', edit: 'deleteBeats' });
    expect(key('Delete', { ctrlKey: true, shiftKey: true })).toEqual({ kind: 'edit', edit: 'eraseNotes' });
    expect(key('Insert', { metaKey: true })).toEqual({ kind: 'edit', edit: 'insertBeat' });
    expect(key('Delete')).toBeNull();
    expect(key('Backspace', { shiftKey: true })).toBeNull();
    expect(key('Home', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(key('End', { altKey: true })).toBeNull();
    expect(key('End', { shiftKey: true })).toEqual({ kind: 'cursor', edge: 'barEnd', extend: true });
  });
  it('finds the cursor targets', () => {
    const at = { track: 0, staff: 0, bar: 2, voice: 0, beat: 1 };
    expect(gp8CursorTarget('barStart', at, 4, 5)).toEqual({ ...at, beat: 0 });
    expect(gp8CursorTarget('barEnd', at, 4, 5)).toEqual({ ...at, beat: 3 });
    expect(gp8CursorTarget('scoreStart', at, 4, 5)).toEqual({ ...at, bar: 0, beat: 0 });
    expect(gp8CursorTarget('scoreEnd', at, 4, 5)).toEqual({ ...at, bar: 4, beat: 0 });
  });
});
