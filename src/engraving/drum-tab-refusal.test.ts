import { describe,expect,it } from 'vitest';
import { model } from '@coderline/alphatab';
import { kitScore } from './drum-tab-fixtures';
import { defaultEngraving,validateEngravingTracks } from './projection';
import { catalogs,setLanguagePreference } from '../i18n';
import { en } from '../i18n/en';

/** Adding a staff to a drum track shown as tab only is refused with a message that names drum tab. */
describe('a drum track shown as tab only that gains a second staff',()=>{
  const tabOnly=()=>{
    const {score,ids}=kitScore();score.tracks[1].addStaff(new model.Staff());
    return {score,ids,overrides:{...defaultEngraving(),profiles:[{trackId:ids[1],profile:'tablature' as const}]}};
  };
  it('names drum tab in English, Estonian and German',()=>{
    const {score,ids,overrides}=tabOnly();
    expect(()=>validateEngravingTracks(score,ids,overrides)).toThrow(en['engraving.drum_tab_one_staff']);
    expect(en['engraving.drum_tab_one_staff']).toMatch(/drum tab/i);
    for(const lang of ['et','de'] as const){
      setLanguagePreference(lang);
      expect(()=>validateEngravingTracks(score,ids,overrides)).toThrow(catalogs[lang]['engraving.drum_tab_one_staff']);
      expect(catalogs[lang]['engraving.drum_tab_one_staff']).not.toBe(en['engraving.drum_tab_one_staff']);
    }
    setLanguagePreference('en');
  });
});
