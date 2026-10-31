import { exporter, importer, model, Settings } from '@coderline/alphatab';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { assertArchiveAccepted } from './archive-gate';
import { trackMixAutomations } from './automation';
import { writePercussionReferences } from './percussion';
import { patchGpifNoteArticulations,projectGpifTracks } from './xml';
import { preparePitchedGpScore } from './pitched';
import { copyLyricsSources,getLyricsSource } from '../editor/lyrics-source';
import { readGpifLyrics,writeGpifLyrics } from './lyrics';
import { writeGpifNotation } from './notation';
import { readGpifHarmony,writeGpifHarmony } from './harmony';
import { readGpifScaleDiagrams,writeGpifScaleDiagrams } from './scale-diagram';
import { gpifCurvesProperty,hasGpifCurves,readGpifCurves,writeGpifCurves } from './curves';
import { withPlainTrills } from '../editor/partial-capo';
import { withPlainDrone } from '../editor/banjo-drone';
import { hasPartialCapo,readGpifPartialCapo,writeGpifPartialCapo } from './partial-capo';
import { copyHarmonySources } from '../harmony/chord-source';
import { copyScaleDiagrams,listScaleDiagrams } from '../harmony/scale-diagram';
import { scoreFromJson } from '../model-clone';
import { captureNoteLinks,restoreNoteLinks } from '../editor/links';
import { copyTimeSignatureSources } from '../editor/time-signature-source';
import { readStylesheetTimeSignatures,writeStylesheetTimeSignatures } from './stylesheet';
import { prepareMusicXmlLoaderBytes } from './musicxml-tempo-offsets';
import { applyMusicXmlNaturalHarmonics } from './musicxml-natural-harmonics';
import { applyMusicXmlHammerPulls } from './musicxml-hammer-pulls';
import { applyMusicXmlDirectionMix } from './musicxml-direction-mix';
import { applyMusicXmlAlternateStaves } from './musicxml-alternate-staves';
import { applyMusicXmlTiedBends } from './musicxml-tied-bends';
import { applyMusicXmlLyricSyllables } from './musicxml-lyric-syllables';
import { applyMusicXmlTempoWords } from './musicxml-tempo-words';

const gpifPath='Content/score.gpif';
const sourceEntries=new WeakMap<model.Score,Record<string,Uint8Array>>();
function unzip(bytes:Uint8Array,settings:Settings){
  assertArchiveAccepted(bytes,settings.importer.maxDecodingBufferSize);
  return unzipSync(bytes,{filter:entry=>{
    if(entry.originalSize>settings.importer.maxDecodingBufferSize||strToU8(entry.name).length>settings.importer.maxDecodingBufferSize)throw new Error('ZIP entry exceeds maxDecodingBufferSize.');
    return true;
  }});
}
function parseXml(xml:string){
  const doc=new DOMParser().parseFromString(xml,'application/xml');
  if(doc.querySelector('parsererror')||doc.documentElement.localName!=='GPIF')throw new Error('Invalid GPIF XML.');
  return doc;
}
function orderedTracks(doc:Document){
  const tracks=new Map([...doc.querySelectorAll('GPIF > Tracks > Track')].map(track=>[track.getAttribute('id'),track]));
  return (doc.querySelector('GPIF > MasterTrack > Tracks')?.textContent??'').trim().split(/\s+/).map(id=>tracks.get(id));
}
const text=(node:Element,name:string)=>node.querySelector(`:scope > ${name}`)?.textContent??'';

function prepareHarmonyGpCarriers(score:model.Score,settings:Settings):model.Score {
  const carriers=score.tracks.flatMap((track,trackIndex)=>track.staves.flatMap((staff,staffIndex)=>staff.bars.flatMap((bar,barIndex)=>bar.voices.flatMap((voice,voiceIndex)=>voice.isEmpty&&voice.beats.some(beat=>beat.hasChord)?[{track:trackIndex,staff:staffIndex,bar:barIndex,voice:voiceIndex}]:[]))));
  if(!carriers.length)return score;
  for(const target of carriers){
    const voice=score.tracks[target.track].staves[target.staff].bars[target.bar].voices[target.voice],beat=voice.beats[0];
    if(voice.beats.length!==1||!beat.isEmpty||beat.notes.length||beat.duration!==model.Duration.Quarter||beat.dots!==0||beat.tupletNumerator>0||beat.tupletDenominator>0||beat.graceType!==model.GraceType.None||beat.overrideDisplayDuration!==undefined)throw new Error('GP export supports an annotated empty carrier only with one existing plain quarter rhythm.');
    const clock=voice.bar.masterBar.calculateDuration();if(!Number.isFinite(clock)||clock<960)throw new Error('The empty chord carrier would extend the existing measure clock in GP export.');
  }
  const copy=scoreFromJson(model.JsonConverter.scoreToJson(score),settings);restoreNoteLinks(copy,captureNoteLinks(score));copyGpInterchangeSource(score,copy);
  for(const target of carriers){
    const voice=copy.tracks[target.track].staves[target.staff].bars[target.bar].voices[target.voice],beat=voice.beats[0];
    // The public writer omits empty Voice references. GP therefore needs this
    // existing silent carrier represented as a rest on the detached export only.
    beat.isEmpty=false;voice.beats=[];voice.addBeat(beat);
  }
  if(copy.masterBars.some((bar,index)=>bar.calculateDuration()!==score.masterBars[index].calculateDuration()))throw new Error('The empty chord carrier would change the existing measure clock in GP export.');
  return copy;
}

/** `partialCapo` false leaves a partial capo the file holds unapplied, as projects logged before the feature replay it. */
export function loadInterchangeScore(bytes:Uint8Array,settings:Settings,partialCapo=true):model.Score {
  // Before the stock reader, which would otherwise inflate a refused archive first.
  assertArchiveAccepted(bytes,settings.importer.maxDecodingBufferSize);
  const score=importer.ScoreLoader.loadScoreFromBytes(prepareMusicXmlLoaderBytes(bytes,settings),settings);
  const musicXml=()=>applyMusicXmlTempoWords(applyMusicXmlLyricSyllables(applyMusicXmlTiedBends(applyMusicXmlAlternateStaves(applyMusicXmlDirectionMix(applyMusicXmlHammerPulls(applyMusicXmlNaturalHarmonics(score,bytes,settings),bytes,settings),bytes,settings),bytes,settings),bytes,settings),bytes,settings),bytes,settings);
  if(bytes[0]!==0x50||bytes[1]!==0x4b)return musicXml();
  const entries=unzip(bytes,settings);
  // The stock GP reader takes any member named score.gpif, so such archives
  // never load from a MusicXML member.
  if(!entries[gpifPath])return Object.keys(entries).some(name=>name.split('/').pop()==='score.gpif')?score:musicXml();
  const xml=new TextDecoder(settings.importer.encoding).decode(entries[gpifPath]),doc=parseXml(projectGpifTracks(xml)?.xml??xml);
  readGpifLyrics(score,doc);
  readGpifHarmony(score,doc);
  readGpifScaleDiagrams(score,doc);
  readGpifPartialCapo(score,doc,partialCapo);
  if(xml.includes(gpifCurvesProperty))readGpifCurves(score,doc,xml);
  orderedTracks(doc).forEach((node,index)=>{
    const track=score.tracks[index];if(!node||!track)return;
    const transpose=node.querySelector(':scope > Transpose');
    if(transpose) {
      const pitch=Number(text(transpose,'Octave'))*12+Number(text(transpose,'Chromatic'));
      if(Number.isFinite(pitch))for(const staff of track.staves)staff.displayTranspositionPitch=pitch;
    }
    const strip=node.querySelector(':scope > RSE > ChannelStrip');if(!strip)return;
    const parameters=text(strip,'Parameters').trim().split(/\s+/).map(Number);
    if(Number.isFinite(parameters[11]))track.playbackInfo.balance=parameters[11]*16;
    if(Number.isFinite(parameters[12]))track.playbackInfo.volume=parameters[12]*16;
    for(const item of strip.querySelectorAll(':scope > Automations > Automation')){
      const type=text(item,'Type');if(type!=='DSPParam_11'&&type!=='DSPParam_12')continue;
      const bar=Number(text(item,'Bar')),ratioPosition=Number(text(item,'Position')),value=Number(text(item,'Value'));
      if(!Number.isSafeInteger(bar)||bar<0||!Number.isFinite(ratioPosition)||ratioPosition<0||ratioPosition>1||!Number.isFinite(value)||value<0||value>1)throw new Error('Invalid GPIF channel-strip automation.');
      const owner=track.staves[0]?.bars[bar]?.voices[0]?.beats[0];if(!owner)throw new Error('GPIF automation refers to missing music.');
      owner.automations.push(Object.assign(new model.Automation(),{type:type==='DSPParam_11'?model.AutomationType.Balance:model.AutomationType.Volume,value:value*16,ratioPosition,isLinear:text(item,'Linear')==='true',isVisible:text(item,'Visible')!=='false',text:text(item,'Text')}));
    }
  });
  readStylesheetTimeSignatures(score,entries);
  sourceEntries.set(score,entries);return score;
}
// A fixed DOS timestamp keeps equal scores byte-identical across export calls.
const archiveOptions={mtime:new Date(1980,0,1)};
export function exportGpInterchange(score:model.Score,settings:Settings):Uint8Array {
  const source=score;score=preparePitchedGpScore(score,settings);copyGpInterchangeSource(source,score);
  score=prepareHarmonyGpCarriers(score,settings);
  const lyricBeatIds=new Set<number>();
  const allBeats=(value:model.Score)=>value.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats))));
  const allStaves=(value:model.Score)=>value.tracks.flatMap(track=>track.staves);
  // Names the XML text cannot carry as written: a CDATA terminator, or a carriage return the parser turns into a line feed.
  const tuningNames=score.tracks.map(track=>track.staves.map(staff=>staff.stringTuning.name)),rawTuning=tuningNames.flat().some(name=>name.includes(']]>')||name.includes('\r'));
  const splitTuning=allStaves(score).some(staff=>staff.stringTuning.name.includes(']]>'));
  if(splitTuning||allBeats(score).some(beat=>beat.lyrics?.some(text=>text.includes(']]>')))){
    const copy=scoreFromJson(model.JsonConverter.scoreToJson(score),settings);
    restoreNoteLinks(copy,captureNoteLinks(score));copyGpInterchangeSource(score,copy);score=copy;
    // The public writer interpolates CDATA verbatim. Split its terminator on
    // this detached export model so both Track and Beat lyrics remain valid XML.
    for(const staff of allStaves(score))if(staff.stringTuning.name.includes(']]>'))staff.stringTuning.name=staff.stringTuning.name.replaceAll(']]>',']]]]><![CDATA[>');
    for(const beat of allBeats(score))if(beat.lyrics?.some(text=>text.includes(']]>'))){lyricBeatIds.add(beat.id);beat.lyrics=beat.lyrics.map(text=>text.replaceAll(']]>',']]]]><![CDATA[>'));}
  }
  const beatIds=new Set([...lyricBeatIds,...allBeats(score).filter(beat=>beat.invertBeamDirection).map(beat=>beat.id)]);
  const masterBars=score.masterBars.some(bar=>!!bar.fermata?.size),notation=beatIds.size||masterBars?{beatIds,masterBars}:undefined;
  const lyrics=score.tracks.some(track=>{const source=getLyricsSource(track);return source&&(source.managed||!source.value.visible||source.value.lines.some(line=>line.text.length>0));});
  const harmony=score.tracks.some(track=>track.staves.some(staff=>!!staff.chords?.size));
  const scales=listScaleDiagrams(score).length>0;
  const partialCapo=hasPartialCapo(score),curves=hasGpifCurves(score);
  const raw=withPlainDrone(score,()=>withPlainTrills(score,()=>new exporter.Gp7Exporter().export(score,settings))),changes=score.tracks.map(trackMixAutomations),needsXml=harmony||scales||lyrics||!!notation||changes.some(stream=>stream.length>0)||score.tracks.some(track=>track.isPercussion)||rawTuning||partialCapo||curves;
  const original=sourceEntries.get(score);
  const generated=unzip(raw,settings);
  const entries:Record<string,Uint8Array>={...generated,...original,[gpifPath]:generated[gpifPath]};
  const activeBacking='Content/Assets/backing-track';
  if(generated[activeBacking])entries[activeBacking]=generated[activeBacking];
  if(!needsXml)return zipSync(writeStylesheetTimeSignatures(score,entries),archiveOptions);
  const xml=new TextDecoder().decode(generated[gpifPath]),projection=projectGpifTracks(xml,notation),doc=parseXml(projection?.xml??xml);
  const references=writePercussionReferences(score,doc,settings);
  writeGpifLyrics(score,doc);writeGpifNotation(score,doc);if(harmony)writeGpifHarmony(score,doc);if(scales)writeGpifScaleDiagrams(score,doc);if(partialCapo)writeGpifPartialCapo(score,doc);if(curves)writeGpifCurves(score,doc,xml);
  for(const node of doc.querySelectorAll('GPIF > Beats > Beat'))if(lyricBeatIds.has(Number(node.getAttribute('id')))){
    // alphaTab's reader keeps only the final adjacent CDATA chunk. Plain XML
    // text retains the combined literal syllable for both readers.
    for(const line of node.querySelectorAll(':scope > Lyrics > Line'))line.textContent=line.textContent;
  }
  if(rawTuning)orderedTracks(doc).forEach((node,index)=>node?.querySelectorAll(':scope > Staves > Staff').forEach((staff,at)=>{
    // As with lyrics, alphaTab's reader keeps only the last adjacent CDATA chunk, and the parser has already turned
    // carriage returns into line feeds, so these labels are rewritten as plain text from the model, matched by position.
    const name=tuningNames[index]?.[at],label=staff.querySelector(':scope > Properties > Property[name="Tuning"] > Label');
    if(label&&name!==undefined&&(name.includes(']]>')||name.includes('\r')))label.textContent=name;
  }));
  orderedTracks(doc).forEach((node,index)=>{
    if(!node)return;
    const strip=node.querySelector(':scope > RSE > ChannelStrip')!;
    let automations=strip.querySelector(':scope > Automations');
    if(!automations){automations=doc.createElement('Automations');strip.append(automations);}
    for(const {bar,automation}of changes[index]){
      const item=doc.createElement('Automation');
      for(const [name,value]of [['Type',automation.type===model.AutomationType.Balance?'DSPParam_11':'DSPParam_12'],['Linear',String(automation.isLinear)],['Bar',String(bar)],['Position',String(automation.ratioPosition)],['Visible',String(automation.isVisible)],['Value',String(automation.value/16)],['Text',automation.text]]){
        const field=doc.createElement(name);field.textContent=value;item.append(field);
      }
      automations.append(item);
    }
  });
  const serializer=new XMLSerializer();
  // XML normalizes literal carriage returns on reimport; preserve raw lyric text.
  const serialize=(node:Node)=>serializer.serializeToString(node).replace(/\r/g,'&#13;');
  let outputXml:string;
  if(projection){
    const patches=[{...projection.tracks,value:serialize(doc.querySelector('GPIF > Tracks')!)}];
    if(projection.masterBars)patches.push({...projection.masterBars,value:serialize(doc.querySelector('GPIF > MasterBars')!)});
    for(const node of doc.querySelectorAll('GPIF > Beats > Beat')){
      const span=projection.beats?.get(Number(node.getAttribute('id')));if(span)patches.push({...span,value:serialize(node)});
    }
    outputXml=xml;
    for(const patch of patches.sort((a,b)=>b.start-a.start))outputXml=outputXml.slice(0,patch.start)+patch.value+outputXml.slice(patch.end);
  }else outputXml=serialize(doc);
  if(references.size){
    const patched=projection?patchGpifNoteArticulations(outputXml,references):undefined;
    if(patched!==undefined)outputXml=patched;
    else{
      const full=projection?parseXml(outputXml):doc;
      for(const note of full.querySelectorAll('GPIF > Notes > Note')){
        const reference=references.get(Number(note.getAttribute('id')));
        if(reference!==undefined)note.querySelector(':scope > InstrumentArticulation')!.textContent=String(reference);
      }
      outputXml=serializer.serializeToString(full);
    }
  }
  entries[gpifPath]=strToU8(outputXml);
  return zipSync(writeStylesheetTimeSignatures(score,entries),archiveOptions);
}
/** Source archive entries that describe tracks by position. Once tracks are added, removed or
 * reordered they would describe the wrong tracks, so export uses alphaTab's regenerated copies. */
const trackOrderedEntry=(path:string)=>path==='Content/PartConfiguration'||path==='Content/LayoutConfiguration'||path.startsWith('Content/ScoreViews/');
export function forgetTrackOrderedEntries(score:model.Score):void {
  const entries=sourceEntries.get(score);
  if(entries)sourceEntries.set(score,Object.fromEntries(Object.entries(entries).filter(([path])=>!trackOrderedEntry(path))));
}

/** Carry source archive siblings and binary backing data omitted by model JSON. */
export function copyGpInterchangeSource(source:model.Score,destination:model.Score):void {
  copyLyricsSources(source,destination);
  copyHarmonySources(source,destination);
  copyScaleDiagrams(source,destination);
  copyTimeSignatureSources(source,destination);
  const entries=sourceEntries.get(source);if(entries)sourceEntries.set(destination,entries);
  if(source.backingTrack?.rawAudioFile&&!destination.backingTrack?.rawAudioFile) {
    destination.backingTrack??=new model.BackingTrack();destination.backingTrack.rawAudioFile=source.backingTrack.rawAudioFile.slice();
  }
}
