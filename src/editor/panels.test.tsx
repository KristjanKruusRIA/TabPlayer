// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { TechniquePanel } from './TechniquePanel';
import { StructurePanel } from './StructurePanel';
import { MeasurePanel } from './MeasurePanel';
import { CurveEditor, BEND_PRESETS, WHAMMY_PRESETS } from './CurveEditor';
import { music, target } from './fixtures';
import { buildScore, previewEdit } from '../engine';
import { blankProject } from '../project';
import { exportAsciiTab } from '../export/ascii-tab';
import type { PitchCurve } from '../edit-types';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({format:'tabplayer-tuning-library',version:1,entries:[]}))}));
afterEach(cleanup);
it('applies pitched staff transposition without requiring a string tuning',()=>{
  const score=previewEdit(blankProject(),{type:'addPitchedTrack',name:'Piano',program:0}).score,onEdit=vi.fn();
  render(<StructurePanel score={score} target={{...target,track:1}} string={1} busy={false} onEdit={onEdit} onSelect={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('Sounding transposition'),{target:{value:'12'}});fireEvent.click(screen.getByRole('button',{name:'Apply staff settings'}));
  expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({type:'setStaffSettings',track:1,settings:expect.objectContaining({tuning:[],transposition:12,showTab:false,showNotation:true})}));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(screen.getByLabelText('Staff tuning (notes, high to low)')).toBeDisabled();
  expect(screen.getByLabelText('Capo')).toBeDisabled();expect(screen.getByLabelText('Show tablature')).toBeDisabled();
});
it('all technique families dispatch finite selected-string commands and refresh readback',()=>{
  const score=music(),onEdit=vi.fn(),props={score,target,string:6,busy:false,onEdit};const view=render(<TechniquePanel {...props}/>);
  fireEvent.click(screen.getByLabelText('Palm mute'));expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{palmMute:true}});
  for(const label of ['Accent','Dynamics','Left-hand finger','Right-hand finger','Slide in','Slide out','Vibrato','Ornament','Harmonic type','Trill speed','Pick stroke','Brush direction','Tremolo speed'])expect(screen.getByLabelText(label)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Tie to next note'}));expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteLink',from:{target,string:6},to:{target:{...target,beat:1},string:6},kind:'tie'});
  fireEvent.click(screen.getByRole('button',{name:'Break tie'}));expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteLink',from:{target,string:6},to:null,kind:'tie'});
  score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].isPalmMute=true;view.rerender(<TechniquePanel {...props}/>);expect(screen.getByLabelText('Palm mute')).toBeChecked();view.rerender(<TechniquePanel {...props} score={music()}/>);expect(screen.getByLabelText('Palm mute')).not.toBeChecked();
  view.rerender(<TechniquePanel {...props} busy/>);expect(screen.getByLabelText('Palm mute')).not.toBeDisabled();expect(screen.getByLabelText('Palm mute').closest('fieldset')).toHaveAttribute('aria-disabled','true');onEdit.mockClear();fireEvent.click(screen.getByLabelText('Palm mute'));expect(onEdit).not.toHaveBeenCalled();
});
it.each([
  ['Let ring','letRing'],['Palm mute','palmMute'],['Dead note','dead'],['Ghost note','ghost'],['Staccato','staccato'],['Left-hand tapping','leftHandTapped'],
] as const)('accessible %s dispatch uses selected string', (label,key)=>{
  const onEdit=vi.fn();render(<TechniquePanel score={music()} target={target} string={6} busy={false} onEdit={onEdit}/>);fireEvent.click(screen.getByLabelText(label));expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{[key]:true}});
});
it.each([
  ['Accent','accent','3'],['Dynamics','dynamics','2'],['Left-hand finger','leftFinger','2'],['Right-hand finger','rightFinger','3'],['Slide in','slideIn','1'],['Slide out','slideOut','4'],['Vibrato','vibrato','2'],['Ornament','ornament','1'],
] as const)('accessible %s dispatch uses finite enum',(label,key,value)=>{
  const onEdit=vi.fn();render(<TechniquePanel score={music()} target={target} string={6} busy={false} onEdit={onEdit}/>);fireEvent.change(screen.getByLabelText(label),{target:{value}});expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{[key]:Number(value)}});
});
it('harmonic trill pick brush tremolo controls dispatch complete field values',()=>{
  const onEdit=vi.fn();render(<TechniquePanel score={music()} target={target} string={6} busy={false} onEdit={onEdit}/>);
  fireEvent.change(screen.getByLabelText('Harmonic type'),{target:{value:'3'}});expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{harmonic:{type:3,value:12}}});
  fireEvent.click(screen.getByLabelText('Trill'));expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{trill:{pitch:69,speed:16}}});
  fireEvent.change(screen.getByLabelText('Pick stroke'),{target:{value:'2'}});expect(onEdit).toHaveBeenLastCalledWith({type:'setBeatTechniques',target,patch:{pickStroke:2}});
  fireEvent.change(screen.getByLabelText('Brush direction'),{target:{value:'3'}});expect(onEdit).toHaveBeenLastCalledWith({type:'setBeatTechniques',target,patch:{brushType:3}});
  fireEvent.click(screen.getByLabelText('Tremolo picking'));expect(onEdit).toHaveBeenLastCalledWith({type:'setBeatTechniques',target,patch:{tremolo:{speed:16,style:0}}});
});
it('copy voice range controls issue one replace-range command',()=>{
  const score=music(),staff=score.tracks[0].staves[0];for(const bar of staff.bars){const voice=new model.Voice();const beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);bar.addVoice(voice);}
  const onEdit=vi.fn();render(<StructurePanel score={score} target={target} string={6} busy={false} onEdit={onEdit} onSelect={vi.fn()}/>);fireEvent.change(screen.getByLabelText('Copy from measure'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('Copy through measure'),{target:{value:'3'}});fireEvent.click(screen.getByRole('button',{name:'Copy voice range'}));expect(onEdit).toHaveBeenLastCalledWith({type:'copyVoice',track:0,staff:0,sourceVoice:0,destinationVoice:1,startBar:1,endBar:2});
});
it('curve editor emits quarter-tone endpoints and supports keyboard inputs',()=>{
  const onChange=vi.fn();render(<CurveEditor label="Bend" value={null} onChange={onChange}/>);
  fireEvent.click(screen.getByLabelText('Enable Bend'));fireEvent.change(screen.getByLabelText('Bend point 2 value'),{target:{value:'4'}});fireEvent.click(screen.getByRole('button',{name:'Apply Bend curve'}));
  expect(onChange).toHaveBeenLastCalledWith({type:1,style:0,points:[{offset:0,value:0},{offset:60,value:4}]});
});
it('interactive bend graph presets, drag gestures, and keyboard handles commit one undoable edit per gesture',()=>{
  const onChange=vi.fn();
  render(<CurveEditor label="Bend" value={null} onChange={onChange}/>);
  fireEvent.click(screen.getByRole('button',{name:'Bend preset: Bend & release'}));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenLastCalledWith({type:model.BendType.BendRelease,style:0,points:[{offset:0,value:0},{offset:30,value:4},{offset:60,value:0}]});

  // Re-clicking the active preset records nothing (Finding 2)
  fireEvent.click(screen.getByRole('button',{name:'Bend preset: Bend & release'}));
  expect(onChange).toHaveBeenCalledTimes(1);

  const middleHandle=screen.getByRole('slider',{name:'Bend graph point 2'});

  // Curve handle clicked without moving records nothing (Finding 2)
  fireEvent.pointerDown(middleHandle,{pointerId:1,clientX:120,clientY:40});
  fireEvent.pointerUp(middleHandle,{pointerId:1,clientX:120,clientY:40});
  expect(onChange).toHaveBeenCalledTimes(1);

  // Moving handle resets type to Custom (Finding 1) and commits on keyup (LOW)
  fireEvent.keyDown(middleHandle,{key:'ArrowUp',shiftKey:true});
  fireEvent.keyUp(middleHandle,{key:'ArrowUp',shiftKey:true});
  expect(onChange).toHaveBeenCalledTimes(2);
  expect(onChange).toHaveBeenLastCalledWith({type:model.BendType.Custom,style:0,points:[{offset:0,value:0},{offset:30,value:6},{offset:60,value:0}]});

  // Held keys repeat keydown without extra commits; keyup commits once (LOW)
  fireEvent.keyDown(middleHandle,{key:'ArrowRight',shiftKey:true,repeat:false});
  fireEvent.keyDown(middleHandle,{key:'ArrowRight',shiftKey:true,repeat:true});
  fireEvent.keyUp(middleHandle,{key:'ArrowRight',shiftKey:true});
  expect(onChange).toHaveBeenCalledTimes(3);
  expect(onChange).toHaveBeenLastCalledWith({type:model.BendType.Custom,style:0,points:[{offset:0,value:0},{offset:40,value:6},{offset:60,value:0}]});

  // Pointer drag updates live during move and commits only once on pointerUp.
  fireEvent.pointerDown(middleHandle,{pointerId:1,clientX:120,clientY:40});
  fireEvent.pointerMove(middleHandle,{pointerId:1,clientX:130,clientY:25});
  fireEvent.pointerMove(middleHandle,{pointerId:1,clientX:140,clientY:20});
  expect(onChange).toHaveBeenCalledTimes(3);
  fireEvent.pointerUp(middleHandle,{pointerId:1,clientX:140,clientY:20});
  expect(onChange).toHaveBeenCalledTimes(4);

  // Lost pointer (pointercancel / lostpointercapture) restores value and commits nothing (Finding 3)
  const countBeforeCancel = onChange.mock.calls.length;
  fireEvent.pointerDown(middleHandle,{pointerId:2,clientX:140,clientY:20});
  fireEvent.pointerMove(middleHandle,{pointerId:2,clientX:150,clientY:10});
  fireEvent.pointerCancel(middleHandle,{pointerId:2});
  expect(onChange).toHaveBeenCalledTimes(countBeforeCancel);

  // Arrow at limit records nothing (Finding 2)
  const maxHandle=middleHandle;
  // Push value to max pitch limit (12)
  for(let i=0;i<10;i++){
    fireEvent.keyDown(maxHandle,{key:'ArrowUp',shiftKey:true});
    fireEvent.keyUp(maxHandle,{key:'ArrowUp',shiftKey:true});
  }
  const callsAtLimit = onChange.mock.calls.length;
  fireEvent.keyDown(maxHandle,{key:'ArrowUp',shiftKey:true});
  fireEvent.keyUp(maxHandle,{key:'ArrowUp',shiftKey:true});
  expect(onChange).toHaveBeenCalledTimes(callsAtLimit);

  fireEvent.keyDown(middleHandle,{key:'Delete'});
  expect(onChange).toHaveBeenLastCalledWith({type:model.BendType.Custom,style:0,points:[{offset:0,value:0},{offset:60,value:0}]});
});

it('bend presets render accurately in real ASCII export (5br, pb mark)',()=>{
  let project=blankProject();
  project=previewEdit(project,{type:'setNote',target,string:1,fret:5}).project;

  let currentCurve: PitchCurve | null = null;
  const view = render(
    <CurveEditor
      label="Bend"
      value={currentCurve}
      onChange={curve => {
        currentCurve = curve;
        if (curve) {
          project = previewEdit(project, {
            type: 'setNoteTechniques',
            target,
            string: 1,
            patch: { bend: curve },
          }).project;
        }
      }}
    />
  );

  // 1. Bend & release preset produces '5br' in ASCII export
  fireEvent.click(screen.getByRole('button', { name: 'Bend preset: Bend & release' }));
  view.rerender(
    <CurveEditor
      label="Bend"
      value={currentCurve}
      onChange={curve => {
        currentCurve = curve;
        if (curve) {
          project = previewEdit(project, {
            type: 'setNoteTechniques',
            target,
            string: 1,
            patch: { bend: curve },
          }).project;
        }
      }}
    />
  );
  let text = new TextDecoder().decode(exportAsciiTab(buildScore(project), { tracks: [0], range: null }));
  expect(text).toContain('5br');

  // 2. Pre-bend preset produces 'pb5' in ASCII export
  fireEvent.click(screen.getByRole('button', { name: 'Bend preset: Pre-bend' }));
  view.rerender(
    <CurveEditor
      label="Bend"
      value={currentCurve}
      onChange={curve => {
        currentCurve = curve;
        if (curve) {
          project = previewEdit(project, {
            type: 'setNoteTechniques',
            target,
            string: 1,
            patch: { bend: curve },
          }).project;
        }
      }}
    />
  );
  text = new TextDecoder().decode(exportAsciiTab(buildScore(project), { tracks: [0], range: null }));
  expect(text).toContain('pb5');

  // 3. Pre-bend & release preset produces 'pb5r' in ASCII export
  fireEvent.click(screen.getByRole('button', { name: 'Bend preset: Pre-bend & release' }));
  view.rerender(
    <CurveEditor
      label="Bend"
      value={currentCurve}
      onChange={curve => {
        currentCurve = curve;
        if (curve) {
          project = previewEdit(project, {
            type: 'setNoteTechniques',
            target,
            string: 1,
            patch: { bend: curve },
          }).project;
        }
      }}
    />
  );
  text = new TextDecoder().decode(exportAsciiTab(buildScore(project), { tracks: [0], range: null }));
  expect(text).toContain('pb5r');
});

it('curve editor respects getScreenCTM, role=group, surface clicks, and single unit x-axis',()=>{
  const onChange=vi.fn();
  const initialCurve={type:model.BendType.Custom,style:0,points:[{offset:0,value:0},{offset:30,value:4},{offset:60,value:0}]};
  const view=render(<CurveEditor label="Bend" value={initialCurve} onChange={onChange}/>);

  // Finding 12: role=group allows slider handles to be recognized by screen readers
  const group=screen.getByRole('group',{name:'Bend pitch curve preview'});
  expect(group).toBeInTheDocument();

  // LOW: X axis reads 0 1/4 1/2 3/4 1 (one unit, not 60)
  expect(within(group).getAllByText('1')).toHaveLength(2);
  expect(within(group).queryByText('60')).not.toBeInTheDocument();

  const surface=screen.getByTestId('bend-graph-surface');

  // Surface right-click records nothing (LOW)
  fireEvent.pointerDown(surface,{button:2,clientX:100,clientY:50});
  expect(onChange).not.toHaveBeenCalled();

  // Surface click on same existing value records nothing (Finding 2)
  // middle point is at offset 30, value 4.
  // PLOT_LEFT is 32, PLOT_WIDTH is 192 -> offset 30 is at x = 32 + (30/60)*192 = 128
  // PLOT_BOTTOM is 104, PLOT_TOP is 12, PLOT_HEIGHT is 92. maxPitch is 12, minPitch is 0.
  // value 4 is ratio 4/12 = 1/3 -> y = 104 - (1/3)*92 = 73.33 -> round is 4
  fireEvent.pointerDown(surface,{button:0,clientX:128,clientY:73});
  expect(onChange).not.toHaveBeenCalled();

  // Finding 10: getScreenCTM handles letterboxed SVG coordinates
  const svg=group as unknown as SVGSVGElement;
  svg.getScreenCTM=vi.fn(()=>({
    a:2,b:0,c:0,d:2,e:10,f:20,
    inverse:()=>({a:0.5,b:0,c:0,d:0.5,e:-5,f:-10} as DOMMatrix),
  } as unknown as DOMMatrix));
  // clientX: 266 -> svgX = 266 * 0.5 - 5 = 128 -> offset 30
  // clientY: 100 -> svgY = 100 * 0.5 - 10 = 40 -> y 40 gives value > 4
  fireEvent.pointerDown(surface,{button:0,clientX:266,clientY:100});
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange.mock.calls[0][0].points.find((p:{offset:number;value:number})=>p.offset===30)?.value).toBeGreaterThan(4);

  // Curve pointer-up skips disabled (LOW)
  onChange.mockClear();
  view.rerender(<CurveEditor label="Bend" value={initialCurve} disabled onChange={onChange}/>);
  const handle=screen.getAllByRole('slider')[1];
  fireEvent.pointerDown(handle,{pointerId:1,clientX:128,clientY:73});
  fireEvent.pointerUp(handle,{pointerId:1,clientX:140,clientY:20});
  expect(onChange).not.toHaveBeenCalled();
});

it('every bend and whammy preset matches alphaTab classification through real engine', () => {
  for (const preset of BEND_PRESETS) {
    let project = blankProject();
    project = previewEdit(project, { type: 'setNote', target, string: 1, fret: 5 }).project;
    project = previewEdit(project, {
      type: 'setNoteTechniques',
      target,
      string: 1,
      patch: { bend: { type: model.BendType.Custom, style: 0, points: preset.points.map(p => ({ ...p })) } },
    }).project;
    const score = buildScore(project);
    const note = score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    expect(note.bendType, `Bend preset ${preset.name} stored type should match engine resolution`).toBe(preset.type);
  }

  for (const preset of WHAMMY_PRESETS) {
    let project = blankProject();
    project = previewEdit(project, { type: 'setNote', target, string: 1, fret: 5 }).project;
    project = previewEdit(project, {
      type: 'setBeatTechniques',
      target,
      patch: { whammy: { type: model.WhammyType.Custom, style: 0, points: preset.points.map(p => ({ ...p })) } },
    }).project;
    const score = buildScore(project);
    const beat = score.tracks[0].staves[0].bars[0].voices[0].beats[0];
    // A preset sent as Custom is classified by the engine; on a lone beat a flat curve below zero is Predive (Hold is covered above).
    const expected = preset.type === model.WhammyType.Custom ? model.WhammyType.Predive : preset.type;
    expect(beat.whammyBarType, `Whammy preset ${preset.name} stored type should match engine resolution`).toBe(expected);
  }
});

it('whammy presets include Scoop and Hold player-facing labels with PrediveDive and Custom types', () => {
  const scoop = WHAMMY_PRESETS.find(p => p.name === 'Scoop');
  expect(scoop).toBeDefined();
  expect(scoop?.type).toBe(model.WhammyType.PrediveDive);

  const hold = WHAMMY_PRESETS.find(p => p.name === 'Hold');
  expect(hold).toBeDefined();
  expect(hold?.type).toBe(model.WhammyType.Custom);
});

it('Hold is what alphaTab calls a flat whammy that continues the previous beat, and a lone flat one is Predive', () => {
  const hold = WHAMMY_PRESETS.find(p => p.name === 'Hold')!;
  const whammyOf = (project: ReturnType<typeof blankProject>, beat: number) =>
    buildScore(project).tracks[0].staves[0].bars[0].voices[0].beats[beat].whammyBarType;
  const custom = (points: { offset: number; value: number }[]) => ({ type: hold.type, style: 0, points });
  let project = blankProject();
  project = previewEdit(project, { type: 'setNote', target, string: 1, fret: 5 }).project;
  project = previewEdit(project, { type: 'setNote', target: { ...target, beat: 1 }, string: 1, fret: 5 }).project;
  const lone = previewEdit(project, { type: 'setBeatTechniques', target: { ...target, beat: 1 }, patch: { whammy: custom(hold.points) } }).project;
  expect(whammyOf(lone, 1)).toBe(model.WhammyType.Predive);
  project = previewEdit(project, { type: 'setBeatTechniques', target, patch: { whammy: custom([{ offset: 0, value: 0 }, { offset: 60, value: -4 }]) } }).project;
  project = previewEdit(project, { type: 'setBeatTechniques', target: { ...target, beat: 1 }, patch: { whammy: custom(hold.points) } }).project;
  expect(whammyOf(project, 1)).toBe(model.WhammyType.Hold);
});

it('bend preset re-click and arrow down-up record nothing through previewEdit', () => {
  let project = blankProject();
  project = previewEdit(project, { type: 'setNote', target, string: 1, fret: 5 }).project;
  const bendPreset = BEND_PRESETS.find(p => p.id === 'bend')!;
  project = previewEdit(project, {
    type: 'setNoteTechniques',
    target,
    string: 1,
    patch: { bend: { type: bendPreset.type, style: 0, points: bendPreset.points.map(p => ({ ...p })) } },
  }).project;
  const note = buildScore(project).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
  const readCurve = {
    type: note.bendType,
    style: note.bendStyle,
    points: note.bendPoints?.map(p => ({ offset: p.offset, value: p.value })) ?? [],
  };

  const onEdit = vi.fn();
  render(<CurveEditor label="Bend" value={readCurve} onChange={onEdit} />);

  // Re-clicking Bend preset records nothing
  fireEvent.click(screen.getByRole('button', { name: `Bend preset: ${bendPreset.name}` }));
  expect(onEdit).not.toHaveBeenCalled();

  // ArrowDown then ArrowUp on handle 2 returns to identical points and records nothing
  const handle = screen.getByRole('slider', { name: 'Bend graph point 2' });
  fireEvent.keyDown(handle, { key: 'ArrowDown', shiftKey: true });
  fireEvent.keyDown(handle, { key: 'ArrowUp', shiftKey: true });
  fireEvent.keyUp(handle, { key: 'ArrowUp', shiftKey: true });
  expect(onEdit).not.toHaveBeenCalled();
});
it('voice staff and layout controls dispatch exact commands',()=>{
  const onEdit=vi.fn();render(<StructurePanel score={music()} target={target} string={6} busy={false} onEdit={onEdit} onSelect={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Add voice'}));expect(onEdit).toHaveBeenLastCalledWith({type:'addVoice',track:0,staff:0});
  fireEvent.click(screen.getByRole('button',{name:'Add staff'}));expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({type:'addStaff',track:0}));
});
it('peg step does not commit staged unapplied settings and focusing dial preserves tuning name',()=>{
  const score=music(),onEdit=vi.fn();
  score.tracks[0].staves[0].stringTuning.name='Drop D';
  score.tracks[0].staves[0].stringTuning.tunings=[64,59,55,50,45,38];
  render(<StructurePanel score={score} target={target} string={6} busy={false} onEdit={onEdit} onSelect={vi.fn()}/>);

  // Focus / click dial with no movement does not erase Drop D (Finding 2)
  const dial=screen.getByRole('slider',{name:'Staff tuning (notes, high to low) string 6 peg'});
  fireEvent.pointerDown(dial,{pointerId:1,clientY:100});
  fireEvent.pointerUp(dial,{pointerId:1,clientY:100});
  expect(onEdit).not.toHaveBeenCalled();

  // Change capo in form input without applying it (staged unapplied setting)
  fireEvent.change(screen.getByLabelText('Capo'),{target:{value:'3'}});

  // Turn peg 6 down (Finding 6)
  fireEvent.keyDown(dial,{key:'ArrowDown'});
  expect(onEdit).toHaveBeenCalledTimes(1);
  // Must commit saved capo:0 from score, NOT staged capo:3!
  expect(onEdit).toHaveBeenLastCalledWith({
    type:'setStaffSettings',
    track:0,
    staff:0,
    settings:expect.objectContaining({
      capo:0,
      tuning:[64,59,55,50,45,37],
      tuningName:'',
    }),
  });
});

it('lost pointer or dragging out and back preserves tuning name in StructurePanel', () => {
  const score = music();
  score.tracks[0].staves[0].stringTuning.name = 'Standard';
  const onEdit = vi.fn();
  render(<StructurePanel score={score} target={target} string={6} busy={false} onEdit={onEdit} onSelect={vi.fn()} />);

  const dial = screen.getByRole('slider', { name: 'Staff tuning (notes, high to low) string 6 peg' });

  // 1. Lost pointer during drag
  fireEvent.pointerDown(dial, { pointerId: 1, clientY: 100, button: 0 });
  fireEvent.pointerMove(dial, { pointerId: 1, clientY: 80 });
  fireEvent.pointerCancel(dial, { pointerId: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'Apply staff settings' }));
  expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({
    type: 'setStaffSettings',
    settings: expect.objectContaining({ tuningName: 'Standard' }),
  }));

  onEdit.mockClear();

  // 2. Dragging out and back
  fireEvent.pointerDown(dial, { pointerId: 2, clientY: 100, button: 0 });
  fireEvent.pointerMove(dial, { pointerId: 2, clientY: 80 });
  fireEvent.pointerMove(dial, { pointerId: 2, clientY: 100 });
  fireEvent.pointerUp(dial, { pointerId: 2, clientY: 100 });
  fireEvent.click(screen.getByRole('button', { name: 'Apply staff settings' }));
  expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({
    type: 'setStaffSettings',
    settings: expect.objectContaining({ tuningName: 'Standard' }),
  }));
});

it('bend preset buttons preserve focus through an edit when disabled becomes true', () => {
  const initialCurve = { type: model.BendType.Bend, style: 0, points: [{ offset: 0, value: 0 }, { offset: 60, value: 4 }] };
  const { rerender } = render(<CurveEditor label="Bend" value={initialCurve} onChange={vi.fn()} />);
  const presetBtn = screen.getByRole('button', { name: 'Bend preset: Bend & release' });
  presetBtn.focus();
  expect(presetBtn).toHaveFocus();

  rerender(<CurveEditor label="Bend" value={initialCurve} disabled onChange={vi.fn()} />);
  expect(presetBtn).toHaveFocus();
  expect(presetBtn).toHaveAttribute('aria-disabled', 'true');
});

it('invalid partial capo or drone shows reason and reverts peg on step in StructurePanel', () => {
  const score = music();
  const onEdit = vi.fn();
  render(<StructurePanel score={score} target={target} string={6} busy={false} onEdit={onEdit} onSelect={vi.fn()} />);

  // Check a string in partial capo without a fret to make partial capo invalid
  const stringCheck = screen.getByRole('checkbox', { name: /String 6/ });
  fireEvent.click(stringCheck);

  // Click peg 6 down
  const downBtn = screen.getByRole('button', { name: 'Tune Staff tuning (notes, high to low) string 6 down' });
  fireEvent.click(downBtn);

  // Must NOT dispatch edit, must show reason in alert, and must revert tuning input
  expect(onEdit).not.toHaveBeenCalled();
  expect(screen.getByText('Fix the partial capo before tuning strings.')).toBeInTheDocument();
  expect(screen.getByLabelText('Staff tuning (notes, high to low)')).toHaveValue('E4 B3 G3 D3 A2 E2');
});

it('invalid banjo drone shows reason and reverts peg on step in StructurePanel', () => {
  const score = music();
  const onEdit = vi.fn();
  render(<StructurePanel score={score} target={target} string={6} busy={false} onEdit={onEdit} onSelect={vi.fn()} />);

  // Turn on banjo drone and type invalid fret 40
  fireEvent.click(screen.getByRole('checkbox', { name: /Short drone string/ }));
  const fretInput = screen.getByLabelText('Drone string starts at fret');
  fireEvent.change(fretInput, { target: { value: '40' } });
  fireEvent.blur(fretInput);

  // Click peg 6 down
  const downBtn = screen.getByRole('button', { name: 'Tune Staff tuning (notes, high to low) string 6 down' });
  fireEvent.click(downBtn);

  // Must NOT dispatch edit, must show reason in alert, and must revert tuning input
  expect(onEdit).not.toHaveBeenCalled();
  expect(screen.getByText('Fix the banjo drone before tuning strings.')).toBeInTheDocument();
  expect(screen.getByLabelText('Staff tuning (notes, high to low)')).toHaveValue('E4 B3 G3 D3 A2 E2');
});

it('busy StructurePanel disables capo and prevents dispatch on Apply staff settings, Add staff, and Add voice', () => {
  const score = music();
  const onEdit = vi.fn();
  render(<StructurePanel score={score} target={target} string={6} busy={true} onEdit={onEdit} onSelect={vi.fn()} />);

  expect(screen.getByLabelText('Capo')).toBeDisabled();

  const applyBtn = screen.getByRole('button', { name: 'Apply staff settings' });
  expect(applyBtn).toBeDisabled();
  fireEvent.click(applyBtn);
  expect(onEdit).not.toHaveBeenCalled();

  const addStaffBtn = screen.getByRole('button', { name: 'Add staff' });
  expect(addStaffBtn).toBeDisabled();
  fireEvent.click(addStaffBtn);
  expect(onEdit).not.toHaveBeenCalled();

  const addVoiceBtn = screen.getByRole('button', { name: 'Add voice' });
  expect(addVoiceBtn).toBeDisabled();
  fireEvent.click(addVoiceBtn);
  expect(onEdit).not.toHaveBeenCalled();
});

it('disabled curve editor prevents Apply from firing onChange, and on a piano note Apply Bend and Apply Whammy record no edit', () => {
  const onChange = vi.fn();
  const curve: PitchCurve = { type: 1, style: 0, points: [{ offset: 0, value: 0 }, { offset: 60, value: 4 }] };
  render(<CurveEditor label="Bend" value={curve} disabled={true} onChange={onChange} />);
  const applyBtn = screen.getByRole('button', { name: 'Apply Bend curve' });
  expect(applyBtn).not.toBeDisabled();
  expect(applyBtn).toHaveAttribute('aria-disabled', 'true');
  applyBtn.focus();
  fireEvent.click(applyBtn);
  fireEvent.keyDown(applyBtn, { key: 'Enter' });
  expect(onChange).not.toHaveBeenCalled();
  expect(applyBtn).toHaveFocus();

  cleanup();

  let project = blankProject();
  project = previewEdit(project, { type: 'addPitchedTrack', name: 'Piano', program: 0 }).project;
  project = previewEdit(project, { type: 'addPitchedNote', target: { track: 1, staff: 0, bar: 0, voice: 0, beat: 0 }, pitch: 60 }).project;
  const score = buildScore(project);
  const onEdit = vi.fn();
  render(<TechniquePanel score={score} target={{ track: 1, staff: 0, bar: 0, voice: 0, beat: 0 }} string={1} noteIndex={0} busy={false} onEdit={onEdit} />);

  const applyBend = screen.getByRole('button', { name: 'Apply Bend curve' });
  const applyWhammy = screen.getByRole('button', { name: 'Apply Whammy curve' });
  expect(applyBend).not.toBeDisabled();
  expect(applyBend).toHaveAttribute('aria-disabled', 'true');
  expect(applyWhammy).not.toBeDisabled();
  expect(applyWhammy).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(applyBend);
  fireEvent.click(applyWhammy);
  expect(onEdit).not.toHaveBeenCalled();
});

it('with busy=true a bend preset button has no disabled attribute and a click records nothing in real TechniquePanel', () => {
  const onEdit = vi.fn();
  render(<TechniquePanel score={music()} target={target} string={6} busy={true} onEdit={onEdit} />);
  const presetBtn = screen.getByRole('button', { name: 'Bend preset: Bend & release' });
  expect(presetBtn.closest('fieldset[disabled]')).toBeNull();
  expect(presetBtn).not.toHaveAttribute('disabled');
  expect(presetBtn).not.toBeDisabled();
  expect(presetBtn).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(presetBtn);
  expect(onEdit).not.toHaveBeenCalled();
});

it('with string 1 edited in the text box and not applied, peg 6 step commits saved string 1 in StructurePanel, and peg 7 is disabled when 7 notes typed', () => {
  const score = music();
  const onEdit = vi.fn();
  render(<StructurePanel score={score} target={target} string={6} busy={false} onEdit={onEdit} onSelect={vi.fn()} />);

  const input = screen.getByLabelText('Staff tuning (notes, high to low)');
  fireEvent.change(input, { target: { value: 'F4 B3 G3 D3 A2 E2' } });

  const peg6Up = screen.getByRole('button', { name: 'Tune Staff tuning (notes, high to low) string 6 up' });
  fireEvent.click(peg6Up);

  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({
    type: 'setStaffSettings',
    settings: expect.objectContaining({
      tuning: [64, 59, 55, 50, 45, 41],
    }),
  }));

  fireEvent.change(input, { target: { value: 'E4 B3 G3 D3 A2 E2 B1' } });
  const peg7Up = screen.getByRole('button', { name: 'Tune Staff tuning (notes, high to low) string 7 up' });
  expect(peg7Up).toBeDisabled();
  const peg7Dial = screen.getByRole('slider', { name: 'Staff tuning (notes, high to low) string 7 peg' });
  expect(peg7Dial).toHaveAttribute('aria-disabled', 'true');
});
it('staff tuning uses named notes, validates drafts and refreshes from history',()=>{
  const score=music(),onEdit=vi.fn(),props={score,target,string:6,busy:false,onEdit,onSelect:vi.fn()};const view=render(<StructurePanel {...props}/>);const input=screen.getByLabelText('Staff tuning (notes, high to low)');expect(input).toHaveValue('E4 B3 G3 D3 A2 E2');
  fireEvent.change(input,{target:{value:'E4 B3 G3 D3 A2 Db2'}});fireEvent.click(screen.getByRole('button',{name:'Apply staff settings'}));expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({type:'setStaffSettings',settings:expect.objectContaining({tuning:[64,59,55,50,45,37]})}));onEdit.mockClear();
  fireEvent.change(input,{target:{value:'E4 bad'}});fireEvent.click(screen.getByRole('button',{name:'Apply staff settings'}));expect(onEdit).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toHaveTextContent(/note|octave/i);
  view.rerender(<StructurePanel {...props} score={music()}/>);expect(input).toHaveValue('E4 B3 G3 D3 A2 E2');
});
it('staff preset readback resets Custom on staff selection and percussion disables tuning',()=>{
  const score=music(),staff=score.tracks[0].staves[0],second=new model.Staff();second.stringTuning.tunings=[...staff.tuning];score.tracks[0].addStaff(second);const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);bar.addVoice(voice);second.addBar(bar);
  const props={score,target,string:6,busy:false,onEdit:vi.fn(),onSelect:vi.fn()},view=render(<StructurePanel {...props}/>);fireEvent.change(screen.getByLabelText('Staff tuning preset'),{target:{value:'custom'}});expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('custom');view.rerender(<StructurePanel {...props} target={{...target,staff:1}}/>);expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('guitar-6-standard-e');second.isPercussion=true;view.rerender(<StructurePanel {...props} target={{...target,staff:1}}/>);expect(screen.getByLabelText('Staff tuning preset')).toBeDisabled();expect(screen.getByLabelText('Staff tuning (notes, high to low)')).toBeDisabled();
});
it('measure meter and tempo controls dispatch current musical values',()=>{
  const onEdit=vi.fn();render(<MeasurePanel score={music()} target={target} string={6} busy={false} onEdit={onEdit}/>);
  fireEvent.change(screen.getByLabelText('Time numerator'),{target:{value:'3'}});fireEvent.click(screen.getByRole('button',{name:'Apply measure settings'}));expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({type:'setMeasureSettings',bar:0,numerator:3,denominator:4}));
});

it('staff settings keep the staff tuning name through capo edits and send the draft name after tuning changes',()=>{
  const score=music(),onEdit=vi.fn(),props={score,target,string:6,busy:false,onEdit,onSelect:vi.fn()};score.tracks[0].staves[0].stringTuning.name='Imported';
  const view=render(<StructurePanel {...props}/>);
  fireEvent.change(screen.getByLabelText('Capo'),{target:{value:'2'}});fireEvent.click(screen.getByRole('button',{name:'Apply staff settings'}));
  expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({type:'setStaffSettings',settings:expect.objectContaining({capo:2,tuning:[64,59,55,50,45,40],tuningName:'Imported'})}));
  fireEvent.change(screen.getByLabelText('Staff tuning (notes, high to low)'),{target:{value:'E4 B3 G3 D3 A2 D2'}});fireEvent.click(screen.getByRole('button',{name:'Apply staff settings'}));
  expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({settings:expect.objectContaining({tuning:[64,59,55,50,45,38],tuningName:''})}));
  fireEvent.click(screen.getByRole('button',{name:'Saved tunings for Staff tuning (notes, high to low)'}));
  fireEvent.click(within(within(screen.getByRole('dialog')).getByRole('group',{name:'Guitar · 6 strings'})).getByRole('button',{name:/^Open D/}));fireEvent.click(screen.getByRole('button',{name:'Use tuning'}));
  fireEvent.click(screen.getByRole('button',{name:'Apply staff settings'}));
  expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({settings:expect.objectContaining({tuning:[62,57,54,50,45,38],tuningName:'Open D'})}));
  const next=music();next.tracks[0].staves[0].stringTuning.name='Fresh';
  view.rerender(<StructurePanel {...props} score={next}/>);fireEvent.click(screen.getByRole('button',{name:'Apply staff settings'}));
  expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({settings:expect.objectContaining({tuning:[64,59,55,50,45,40],tuningName:'Fresh'})}));
});

const flat: PitchCurve = { type: model.BendType.Bend, style: 0, points: [{ offset: 0, value: 0 }, { offset: 60, value: 4 }] };
it('Apply keeps focus and the focus ring when busy flips on, and a press while busy records nothing', () => {
  const onChange = vi.fn();
  const { rerender } = render(<CurveEditor label="Bend" value={flat} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText('Bend point 2 value'), { target: { value: '6' } });
  const apply = screen.getByRole('button', { name: 'Apply Bend curve' });
  apply.focus();
  fireEvent.click(apply);
  expect(onChange).toHaveBeenCalledTimes(1);
  rerender(<CurveEditor label="Bend" value={flat} disabled onChange={onChange} />);
  expect(apply).toHaveFocus();
  expect(apply).not.toHaveAttribute('disabled');
  expect(apply.closest('fieldset[disabled]')).toBeNull();
  expect(apply).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(apply);
  fireEvent.keyDown(apply, { key: ' ' });
  expect(onChange).toHaveBeenCalledTimes(1);
});
it('TechniquePanel controls that hold focus stay enabled and focused when busy flips, and refuse the press', () => {
  const onEdit = vi.fn(), props = { score: music(), target, string: 6, onEdit };
  const { rerender } = render(<TechniquePanel {...props} busy={false} />);
  for (const control of [screen.getByLabelText('Let ring'), screen.getByRole('button', { name: 'Tie to next note' }), screen.getByRole('button', { name: 'Break tie' }), screen.getByLabelText('Enable Whammy')]) {
    control.focus();
    rerender(<TechniquePanel {...props} busy />);
    expect(control).toHaveFocus();
    expect(control).not.toBeDisabled();
    rerender(<TechniquePanel {...props} busy={false} />);
  }
  rerender(<TechniquePanel {...props} busy />);
  fireEvent.click(screen.getByLabelText('Let ring'));
  fireEvent.click(screen.getByRole('button', { name: 'Tie to next note' }));
  fireEvent.click(screen.getByRole('button', { name: 'Break tie' }));
  fireEvent.change(screen.getByLabelText('Pick stroke'), { target: { value: '2' } });
  expect(onEdit).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Let ring')).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Break tie' })).toHaveAttribute('aria-disabled', 'true');
});
it('Apply on an unchanged curve records nothing, on a changed curve records once', () => {
  const onChange = vi.fn();
  const { rerender } = render(<CurveEditor label="Bend" value={flat} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Apply Bend curve' }));
  expect(onChange).not.toHaveBeenCalled();
  rerender(<CurveEditor label="Bend" value={null} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Apply Bend curve' }));
  expect(onChange).not.toHaveBeenCalled();
  rerender(<CurveEditor label="Bend" value={flat} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText('Bend point 2 value'), { target: { value: '6' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply Bend curve' }));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange.mock.calls[0][0].points[1].value).toBe(6);
  onChange.mockClear();
  fireEvent.change(screen.getByLabelText('Bend point 2 value'), { target: { value: '4' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply Bend curve' }));
  expect(onChange).not.toHaveBeenCalled();
});
it('busy between a handle key press and its release or blur reverts the graph to the saved curve and records nothing', () => {
  for (const release of ['keyUp', 'blur'] as const) {
    const onChange = vi.fn();
    const { rerender, unmount } = render(<CurveEditor label="Bend" value={flat} onChange={onChange} />);
    const handle = screen.getByRole('slider', { name: 'Bend graph point 2' });
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(handle).toHaveAttribute('aria-valuenow', '5');
    rerender(<CurveEditor label="Bend" value={flat} disabled onChange={onChange} />);
    if (release === 'keyUp') fireEvent.keyUp(handle, { key: 'ArrowUp' });
    else fireEvent.blur(handle);
    expect(screen.getByRole('slider', { name: 'Bend graph point 2' })).toHaveAttribute('aria-valuenow', '4');
    expect(onChange).not.toHaveBeenCalled();
    unmount();
  }
});

it('the Hold preset button sends Custom with flat points so the engine classifies it', () => {
  const onChange = vi.fn();
  render(<CurveEditor label="Whammy" whammy value={null} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Whammy preset: Hold' }));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ type: model.WhammyType.Custom, points: [{ offset: 0, value: -4 }, { offset: 60, value: -4 }] }));
});

it('StructurePanel keep pitch checkbox passes keepPitch: true to setStaffSettings', () => {
  const score = music(), onEdit = vi.fn(), props = { score, target, string: 6, busy: false, onEdit, onSelect: vi.fn() };
  render(<StructurePanel {...props} />);
  const keepPitch = screen.getByLabelText('Keep pitch');
  expect(keepPitch).not.toBeChecked();
  fireEvent.click(keepPitch);
  expect(keepPitch).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Apply staff settings' }));
  expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({
    type: 'setStaffSettings',
    track: 0,
    staff: 0,
    settings: expect.objectContaining({ keepPitch: true }),
  }));
});
