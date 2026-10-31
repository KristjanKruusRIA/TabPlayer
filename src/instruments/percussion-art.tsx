import { memo, type ReactNode } from 'react';

const wood='#b57a3c',woodDark='#6d4320',skin='#efe9d6',metal='#c9cfd1',metalDark='#5c6468',brass='#dcb65e',black='#22262a',red='#a8262f';
const drumTop=(cx:number,cy:number,r:number,body:string,height:number,taper=0)=><><path d={`M${cx-r} ${cy}L${cx-r+taper} ${cy+height}Q${cx} ${cy+height+r*.32} ${cx+r-taper} ${cy+height}L${cx+r} ${cy}Z`} fill={body} stroke="#14171a"/><ellipse cx={cx} cy={cy} rx={r} ry={r*.3} fill={skin} stroke={metal} strokeWidth="1.6"/></>;
const cowbell=(scale:number)=><g transform={`translate(28 22) scale(${scale})`}><path d="M-9-15H9L15 15H-15Z" fill="#3a3f43" stroke={metal} strokeWidth="1.2"/><path d="M-5-13L-8 13" stroke="#7d868a" strokeWidth="2"/><rect x="-4" y="-20" width="8" height="6" fill={metal}/></g>;
const block=(height:number)=><><rect x="9" y={32-height} width="38" height={height} rx="3" fill={wood} stroke={woodDark}/><path d={`M14 ${32-height/2}H42`} stroke="#3a220f" strokeWidth="2.4"/><path d={`M12 ${35-height}H44`} stroke="#dba86c" opacity=".6"/></>;
const bong=(cx:number,r:number,height:number)=>drumTop(cx,12,r,wood,height,3);
const stick=(x:number,y:number,angle:number,fill:string,length=38)=><rect x={x} y={y} width={length} height="4.4" rx="2" fill={fill} stroke="#1c1c1c" strokeWidth=".5" transform={`rotate(${angle} ${x} ${y})`}/>;
const maraca=(mirror:boolean)=><g transform={mirror?'matrix(-1 0 0 1 56 0)':undefined}><rect x="27" y="22" width="4" height="19" rx="2" fill={woodDark} transform="rotate(24 29 22)"/><ellipse cx="33" cy="15" rx="10" ry="12.5" fill={red} stroke="#3d0d12" transform="rotate(24 33 15)"/><path d="M30 8L40 22M36 6L44 16" stroke="#e8c15b" strokeWidth="1.4"/></g>;
const agogo=(scale:number)=><g transform={`translate(28 7) scale(${scale})`}><path d="M-6-3C-6 8-12 18-12 28H6C6 18 2 8 0-3Z" fill={brass} stroke="#6a4b18"/><path d="M-1-3C12-6 20 2 20 12" fill="none" stroke={metal} strokeWidth="2.4"/></g>;
const whistle=(body:string)=><><path d="M9 16H34A10 10 0 1 1 25 31H19C15 31 16 22 9 22Z" fill={body} stroke="#14171a"/><circle cx="35" cy="25" r="4.5" fill="#14171a" opacity=".55"/><rect x="24" y="16" width="6" height="3" fill="#14171a"/><path d="M9 18H1" stroke={metal} strokeWidth="3"/></>;

const icons:Record<string,ReactNode>={
  'cowbell-low':cowbell(1.15),cowbell:cowbell(1),'cowbell-high':cowbell(.82),
  'woodblock-low':block(20),'woodblock-high':block(14),
  tambourine:<><ellipse cx="28" cy="22" rx="20" ry="17" fill={skin} stroke={wood} strokeWidth="4"/>{[0,1,2,3,4,5].map(i=>{const a=i*Math.PI/3+.5;return <rect key={i} x={26+Math.cos(a)*20-3} y={21+Math.sin(a)*17-2} width="7" height="3.6" rx="1.8" fill={brass} stroke="#6a4b18" strokeWidth=".5"/>;})}</>,
  triangle:<><path d="M28 7L47 37H9Z" fill="none" stroke={metal} strokeWidth="3" strokeLinejoin="round"/><path d="M28 7V1" stroke="#7d868a"/><path d="M46 3L27 26" stroke={metalDark} strokeWidth="1.6"/></>,
  'bongo-high':<>{bong(38,12,22)}{bong(18,15,24)}<ellipse cx="38" cy="12" rx="12" ry="3.6" fill="#7fb2ff" opacity=".35"/></>,
  'bongo-low':<>{bong(38,12,22)}{bong(18,15,24)}<ellipse cx="18" cy="12" rx="15" ry="4.5" fill="#7fb2ff" opacity=".35"/></>,
  'conga-high':drumTop(28,6,12,wood,32,3),'conga-low':drumTop(28,6,16,woodDark,32,4),
  'timbale-high':<>{drumTop(28,10,14,metal,18)}<path d="M18 28V42M38 28V42" stroke={metalDark} strokeWidth="2"/></>,
  'timbale-low':<>{drumTop(28,10,19,metal,18)}<path d="M14 28V42M42 28V42" stroke={metalDark} strokeWidth="2"/></>,
  'agogo-high':agogo(.82),'agogo-low':agogo(1.08),
  surdo:<>{drumTop(28,8,20,metal,24)}<path d="M9 18L47 28M9 28L47 18" stroke={metalDark} strokeWidth=".8"/></>,
  cuica:<><path d="M12 12H44V34H12Z" fill={metal} stroke={metalDark}/><ellipse cx="44" cy="23" rx="4" ry="11" fill={skin} stroke={metalDark}/><path d="M42 23H22" stroke={wood} strokeWidth="2"/></>,
  vibraslap:<><path d="M6 34C20 34 26 12 38 12" fill="none" stroke={metal} strokeWidth="2.6"/><circle cx="7" cy="33" r="6" fill={red} stroke="#3d0d12"/><rect x="32" y="6" width="20" height="13" rx="3" fill={wood} stroke={woodDark}/><path d="M36 12H49" stroke="#3a220f" strokeWidth="2"/></>,
  guiro:<><ellipse cx="28" cy="22" rx="24" ry="11" fill={wood} stroke={woodDark}/>{[14,19,24,29,34,39].map(x=><path key={x} d={`M${x} 13V31`} stroke="#3a220f" strokeWidth="1.2"/>)}</>,
  cabasa:<><rect x="6" y="20" width="22" height="4.6" rx="2" fill={woodDark}/><ellipse cx="38" cy="22" rx="13" ry="16" fill={wood} stroke={woodDark}/>{[-2,-1,0,1,2].map(i=><ellipse key={i} cx="38" cy={22+i*5.6} rx={Math.sqrt(1-(i*.35)**2)*13} ry="1.1" fill={metal}/>)}</>,
  shaker:<><rect x="8" y="14" width="40" height="17" rx="8" fill="#39444c" stroke={metal}/><path d="M16 14V31M40 14V31" stroke={metal} strokeWidth="2"/></>,
  'maraca-left':maraca(false),'maraca-right':maraca(true),
  claves:<>{stick(8,10,14,wood)}{stick(8,32,-14,wood)}</>,
  castanets:<><path d="M8 24A20 16 0 0 1 48 24Z" fill={woodDark} stroke="#2b1a0c"/><path d="M8 27A20 12 0 0 0 48 27Z" fill={wood} stroke="#2b1a0c"/><path d="M28 8V2" stroke={red} strokeWidth="2"/></>,
  'bell-tree':<><path d="M28 2V40" stroke={metalDark} strokeWidth="1.6"/>{[[6,8],[13,11],[21,14],[30,17],[39,20]].map(([y,r])=><path key={y} d={`M${28-r} ${y+6}A${r} 8 0 0 1 ${28+r} ${y+6}Z`} fill={brass} stroke="#6a4b18" strokeWidth=".6"/>)}</>,
  'jingle-bell':<><path d="M28 5V12" stroke={red} strokeWidth="2"/><circle cx="20" cy="26" r="9" fill={brass} stroke="#6a4b18"/><circle cx="37" cy="24" r="9" fill={brass} stroke="#6a4b18"/><circle cx="28" cy="15" r="8" fill={brass} stroke="#6a4b18"/><path d="M15 27H25M32 25H42M23 16H33" stroke="#4b3510"/></>,
  'whistle-high':whistle(metal),'whistle-low':whistle(brass),
  grancassa:<><circle cx="28" cy="22" r="19" fill={skin} stroke={woodDark} strokeWidth="4"/><circle cx="28" cy="22" r="12" fill="none" stroke="#b5b2a5"/><path d="M47 40L30 24" stroke={wood} strokeWidth="2.4"/><circle cx="29" cy="23" r="4" fill={red}/></>,
  piatti:<><ellipse cx="20" cy="22" rx="16" ry="19" fill={brass} stroke="#6a4b18"/><ellipse cx="37" cy="22" rx="16" ry="19" fill="#e9c778" stroke="#6a4b18"/><circle cx="37" cy="22" r="4" fill={red}/></>,
  'electric-snare':<><ellipse cx="28" cy="19" rx="22" ry="11" fill={black} stroke={metalDark} strokeWidth="2"/><ellipse cx="28" cy="18" rx="16" ry="7.5" fill="#3a4148"/><path d="M6 21V27Q28 40 50 27V21" fill="none" stroke={metalDark} strokeWidth="2"/></>,
  'hand-clap':<><path d="M14 38L8 16C7 12 12 10 14 14L19 24 18 7C18 3 24 3 24 7L26 22 29 6C30 2 35 3 35 7L33 26 40 16C43 13 47 16 45 20L34 38Z" fill="#d6a884" stroke="#6d4a33"/></>,
  golpe:<><path d="M7 24C7 12 20 10 26 15C33 9 49 12 49 25C49 37 33 38 26 34C20 38 7 36 7 24Z" fill={wood} stroke={woodDark}/><circle cx="29" cy="23" r="6" fill="#23150a"/></>,
  metronome:<><path d="M20 5H36L46 39H10Z" fill={wood} stroke={woodDark}/><path d="M23 12H33L38 34H18Z" fill={skin}/><path d="M28 34L37 9" stroke={black} strokeWidth="2"/><rect x="31" y="17" width="6" height="4" fill={black} transform="rotate(20 34 19)"/></>,
};
function PercussionArtBase({id}:{id:string}) {return <svg className="percussion-art" viewBox="0 0 56 44" aria-hidden="true" focusable="false">{icons[id]}</svg>;}
export const PercussionArt=memo(PercussionArtBase);
export const hasPercussionArt=(id:string)=>id in icons;
