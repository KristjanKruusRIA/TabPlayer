import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { exporter, importer, model, Settings } from '@coderline/alphatab';
import type { NoteTechniques, BeatTechniques } from '../edit-types';
import { applyNoteTechniques, applyBeatTechniques } from './techniques';
import { music, noteAt, target } from './fixtures';
it('records per-field GP exporter coverage including pitch curve points',()=>{
  const notes:Record<string,NoteTechniques>={letRing:{letRing:true},palmMute:{palmMute:true},dead:{dead:true},ghost:{ghost:true},staccato:{staccato:true},leftHandTapped:{leftHandTapped:true},accent:{accent:3},dynamics:{dynamics:3},leftFinger:{leftFinger:1},rightFinger:{rightFinger:2},slideIn:{slideIn:1},slideOut:{slideOut:3},vibrato:{vibrato:2},ornament:{ornament:1},bend:{bend:{type:2,style:1,points:[{offset:0,value:0},{offset:30,value:3},{offset:60,value:4}]}},harmonic:{harmonic:{type:3,value:12}},trill:{trill:{pitch:70,speed:16}}};
  const beats:Record<string,BeatTechniques>={pickStroke:{pickStroke:2},brush:{brushType:3,brushDuration:60},whammy:{whammy:{type:1,style:1,points:[{offset:0,value:0},{offset:30,value:-2},{offset:60,value:-4}]}},tremolo:{tremolo:{speed:32,style:1}}};
  const snapshot=(score:model.Score)=>{const n=noteAt(score),b=n.beat;return {letRing:n.isLetRing,palmMute:n.isPalmMute,dead:n.isDead,ghost:n.isGhost,staccato:n.isStaccato,leftHandTapped:n.isLeftHandTapped,accent:n.accentuated,dynamics:n.dynamics,leftFinger:n.leftHandFinger,rightFinger:n.rightHandFinger,slideIn:n.slideInType,slideOut:n.slideOutType,vibrato:n.vibrato,ornament:n.ornament,bend:{type:n.bendType,style:n.bendStyle,points:n.bendPoints?.map(p=>({offset:p.offset,value:p.value}))},harmonic:{type:n.harmonicType,value:n.harmonicValue},trill:{pitch:n.trillValue,speed:n.trillSpeed},pickStroke:b.pickStroke,brush:{type:b.brushType,duration:b.brushDuration},whammy:{type:b.whammyBarType,style:b.whammyStyle,points:b.whammyBarPoints?.map(p=>({offset:p.offset,value:p.value}))},tremolo:{speed:b.tremoloSpeed,style:b.tremoloPicking?.style}};};
  const results=[];
  for(const [field,patch] of Object.entries({...notes,...beats})) {
    const score=music();if(field in notes)applyNoteTechniques(score,{target,string:6},patch as NoteTechniques);else applyBeatTechniques(score,target,patch as BeatTechniques);
    const bytes=new exporter.Gp7Exporter().export(score,new Settings()),imported=importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings()),before=snapshot(score)[field as keyof ReturnType<typeof snapshot>],after=snapshot(imported)[field as keyof ReturnType<typeof snapshot>];
    results.push({field,retained:JSON.stringify(before)===JSON.stringify(after),before,after,exportSha256:createHash('sha256').update(bytes).digest('hex')});expect(bytes.length).toBeGreaterThan(0);
  }
  mkdirSync('.analysis/expansion',{recursive:true});writeFileSync('.analysis/expansion/gp-editor-coverage.json',JSON.stringify({engineVersion:'1.8.4',results},null,2));expect(results).toHaveLength(21);
});
