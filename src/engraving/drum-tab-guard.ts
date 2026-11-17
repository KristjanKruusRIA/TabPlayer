import { Environment,NotationElement,type model } from '@coderline/alphatab';

/**
 * A drum track drawn as standard notation and tablature has two model staves: the percussion staff and the tab staff `convertDrumTabJson`
 * adds after it. alphaTab 1.8.4 gives the bands that sit above and below a staff (dynamics, fermatas, volta brackets, directions, triplet feel)
 * to the first staff of a track that has a renderer for them, and the tab staff has none of the score renderers, so it would inherit all of
 * them and draw each a second time under the tab. A guitar's "standard + tablature" is one model staff and does not have this. These bands
 * are left off the staves registered here; nothing else about them changes, and the percussion staff keeps its own.
 *
 * The effect infos are shared by every renderer (`Environment.defaultRenderers`), so the guard is installed once, by wrapping their
 * `shouldCreateGlyph`. They are not exported by alphaTab; the lookup is by their public `notationElement`, and `installed` tells a test whether
 * this alphaTab still has them.
 */
const GUARDED=[NotationElement.EffectDynamics,NotationElement.EffectFermata,NotationElement.EffectAlternateEndings,NotationElement.EffectDirections,NotationElement.EffectTripletFeel];

/** The tab staves drawn beside a percussion staff of the same track. */
const companionTabStaves=new WeakSet<model.Staff>();
/** Marks `staff` as a drum tab staff drawn beside its percussion staff: it repeats none of the marks above and below the staff. */
export function registerDrumTabCompanion(staff:model.Staff):void {companionTabStaves.add(staff);}
export const isDrumTabCompanion=(staff:model.Staff):boolean=>companionTabStaves.has(staff);

type Info={notationElement:NotationElement;shouldCreateGlyph(settings:unknown,beat:model.Beat):boolean};
const marker=Symbol.for('tabplayer.drumTabGuard');
function install():NotationElement[] {
  const factories=(Environment as unknown as {defaultRenderers?:Array<{effectBands?:Array<{effect?:Info}>}>}).defaultRenderers;
  const covered=new Set<NotationElement>();
  for(const factory of factories??[])for(const band of factory.effectBands??[]){
    const info=band.effect as (Info&{[marker]?:true})|undefined;
    if(!info||typeof info.shouldCreateGlyph!=='function'||!GUARDED.includes(info.notationElement))continue;
    covered.add(info.notationElement);
    if(info[marker])continue;
    const original=info.shouldCreateGlyph;
    info.shouldCreateGlyph=function guarded(this:Info,settings,beat){return companionTabStaves.has(beat.voice.bar.staff)?false:original.call(this,settings,beat);};
    info[marker]=true;
  }
  return [...covered];
}
/** The notation elements whose bands the guard covers. All of `GUARDED` unless this alphaTab no longer has them where the guard looks. */
export const guardedElements:readonly NotationElement[]=install();
export const guardedAll=GUARDED.every(element=>guardedElements.includes(element));
