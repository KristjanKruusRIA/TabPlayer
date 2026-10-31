import { busyGuard } from '../ui/useBusyGuard';
import { neighbourSection,sectionAt,type SectionStart } from './sections';

/** Jumps between the named sections of the song; a section is named with the Section label of a measure. */
export function SectionsPanel({sections,bar,onGo}:{sections:readonly SectionStart[];bar:number;onGo:(bar:number)=>void}) {
  const current=sectionAt(sections,bar),previous=neighbourSection(sections,bar,'previous'),next=neighbourSection(sections,bar,'next');
  return <details className="editor-section"><summary>Sections ({sections.length})</summary>
    {sections.length?<>
      <div className="pair">
        <button {...busyGuard({unavailable:previous===null,onClick:()=>onGo(previous!)})}>Previous section</button>
        <button {...busyGuard({unavailable:next===null,onClick:()=>onGo(next!)})}>Next section</button>
      </div>
      <ul className="score-error-list" aria-label="Sections">{sections.map((section,index)=>
        <li key={section.bar}><button aria-current={index===current?'location':undefined} onClick={()=>onGo(section.bar)}>{`Measure ${section.bar+1} · ${section.name}`}</button></li>)}</ul>
    </>:<p className="muted">No sections yet. Give a measure a Section label under Measure &amp; notation to list it here.</p>}
  </details>;
}
