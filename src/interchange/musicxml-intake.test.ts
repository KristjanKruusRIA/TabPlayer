import { createHash } from 'node:crypto';
import { expect,it } from 'vitest';
import { strToU8,zipSync } from 'fflate';
import { buildScore,previewEdit } from '../engine';
import { blankProject } from '../project';

const xml=`<?xml version="1.0"?><score-partwise version="4.0"><work><work-title>Authored piano</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name><midi-instrument id="I1"><midi-channel>1</midi-channel><midi-program>1</midi-program></midi-instrument></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`;
it.each(['xml','musicxml','mxl'])('opens and edits authored %s while retaining immutable source bytes',extension=>{
  const bytes=extension==='mxl'?zipSync({
    'META-INF/container.xml':strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.xml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'),
    'score.xml':strToU8(xml),
  }):strToU8(xml);
  const base={kind:'file' as const,filename:`authored.${extension}`,bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
  const project={...blankProject(),base},score=buildScore(project),note=(value:typeof score)=>value.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
  // The notation importer uses nonbreaking spaces in displayed text.
  expect(note(score).realValue).toBe(60);expect(score.title).toMatch(/^Authored\s+piano$/);
  const changed=previewEdit(project,{type:'setPitchedNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},noteIndex:0,pitch:62});
  expect(note(buildScore(JSON.parse(JSON.stringify(changed.project)))).realValue).toBe(62);
  expect(changed.project.base).toEqual(base);
});
