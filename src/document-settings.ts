import type { model } from '@coderline/alphatab';
import type { DocumentSettings, FxSettings, SettingsEdit, ChannelMix, PrintLayout } from './edit-types';
import {defaultEngraving,validateEngravingTracks} from './engraving/projection';
import {validatePageLayout} from './engraving/page';
export type { DocumentSettings, FxSettings, TrackSound, ChannelMix, PrintLayout, SyncAnchor, BackingSettings } from './edit-types';

export const defaultMix = (): ChannelMix => ({gain:1,pan:0,mute:false,solo:false});
export const defaultEffects = (): FxSettings => ({
  gate:{enabled:false,thresholdDb:-60,releaseMs:100},
  compressor:{enabled:false,thresholdDb:-18,ratio:4,attackMs:10,releaseMs:100,makeupDb:0},
  amp:{enabled:false,model:'clean',drive:.1,gainDb:0},cabinet:{enabled:false,model:'open'},
  eq:{enabled:false,lowDb:0,midDb:0,highDb:0,midHz:1000},chorus:{enabled:false,rateHz:1,depthMs:5,mix:.15},
  delay:{enabled:false,quarterNotes:1,feedback:.25,mix:.15},reverb:{enabled:false,room:.5,damping:.5,mix:.12},
});
export const defaultPrintLayout = (): PrintLayout => ({paper:'A4',orientation:'portrait',marginMm:15,scale:1,profile:'ScoreTab'});
export const defaultDocumentSettings = (): DocumentSettings => ({sounds:{},mixes:{},backing:null,print:defaultPrintLayout(),engraving:defaultEngraving(),page:null});

export function validateMix(mix: ChannelMix) {
  if (!mix || !Number.isFinite(mix.gain) || mix.gain<0 || mix.gain>1 || !Number.isFinite(mix.pan) || Math.abs(mix.pan)>1 || typeof mix.mute!=='boolean' || typeof mix.solo!=='boolean') throw new Error('Invalid mixer settings.');
}

export function applySettingsEdit(settings: DocumentSettings, edit: SettingsEdit, score: model.Score, trackIds: readonly string[]) {
  switch (edit.type) {
    case 'setTrackMix':
      if (!trackIds.includes(edit.trackId)) throw new Error('Select an existing track.');
      validateMix(edit.mix); settings.mixes[edit.trackId]=structuredClone(edit.mix); break;
    case 'setTrackSound':
      if (!trackIds.includes(edit.trackId)) throw new Error('Select an existing track.');
      if (!['gm','clean','crunch','lead','bass'].includes(edit.sound.presetId)) throw new Error('Invalid sound preset.');
      for(const block of Object.values(edit.sound.effects)) for(const value of Object.values(block)) if(typeof value==='number' && !Number.isFinite(value)) throw new Error('Invalid effect parameter.');
      settings.sounds[edit.trackId]=structuredClone(edit.sound); break;
    case 'setBacking': {
      const backing=edit.backing;
      if(backing) {
        validateMix(backing.mix);
        if(!Number.isFinite(backing.offsetMs)) throw new Error('Invalid backing offset.');
        for(const anchor of backing.anchors) if(!Number.isInteger(anchor.bar) || !score.masterBars[anchor.bar] || !Number.isInteger(anchor.occurrence) || anchor.occurrence<0 || !Number.isFinite(anchor.ratio) || anchor.ratio<0 || anchor.ratio>1 || !Number.isFinite(anchor.audioMs) || anchor.audioMs<0) throw new Error('Invalid backing synchronization anchor.');
      }
      settings.backing=structuredClone(backing); break;
    }
    case 'setPrintLayout': {
      const p=edit.layout;
      if(!['A4','Letter'].includes(p.paper) || !['portrait','landscape'].includes(p.orientation) || !['ScoreTab','Score','Tab'].includes(p.profile) || !Number.isFinite(p.marginMm) || p.marginMm<0 || !Number.isFinite(p.scale) || p.scale<=0) throw new Error('Invalid print layout.');
      settings.print=structuredClone(p);settings.page=null;break;
    }
    case 'setEngraving':validateEngravingTracks(score,trackIds,edit.engraving);settings.engraving=structuredClone(edit.engraving);break;
    case 'setPageLayout':validatePageLayout(edit.layout);settings.page=structuredClone(edit.layout);break;
  }
}
