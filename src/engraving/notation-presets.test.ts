import { expect,it } from 'vitest';
import { notationPresets,presetApplied } from './notation-presets';
import { defaultEngraving,validateEngraving } from './projection';

it('preset_load_keeps_draft_fonts',()=>{
  const draft=defaultEngraving();draft.fonts={music:'leland',roles:{lyrics:{font:'notoSerif',italic:true}}};
  for(const preset of notationPresets){
    const applied=presetApplied(preset,draft);
    expect(applied.fonts).toEqual(draft.fonts);expect(applied.fonts).not.toBe(draft.fonts);validateEngraving(applied);
    expect(applied.typography?.family).toBe(preset.typography.family);
    const plain=presetApplied(preset,defaultEngraving());expect(plain.fonts).toBeUndefined();
  }
});
it('presets_set_no_fonts',()=>{
  for(const preset of notationPresets)expect('fonts' in preset).toBe(false);
});
