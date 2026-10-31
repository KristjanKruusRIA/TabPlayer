import { describe, expect, it } from 'vitest';
import { planFailureMessage } from './plan-error';

describe('planFailureMessage', () => {
  it('turns engine limit errors into a readable message', () => {
    let caught: unknown;
    try { Math.max(...new Array(500000).fill(1)); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RangeError);
    expect(planFailureMessage(caught)).toMatch(/too large or complex to play/);
    expect(planFailureMessage(caught)).not.toMatch(/call stack/);
  });
  it('keeps the detail of other failures', () => {
    expect(planFailureMessage(new Error('bad tempo'))).toBe('Playback could not be prepared for this score: bad tempo');
    expect(planFailureMessage('odd')).toContain('odd');
  });
});
