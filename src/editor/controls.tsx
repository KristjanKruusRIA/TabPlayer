import { busySelect } from '../ui/useBusyGuard';
export function EnumInput({label,value,enumeration,onValue,disabled,busy}: {label:string;value:number;enumeration:object;onValue:(value:number)=>void;disabled?:boolean;busy?:boolean}) {
  return <label>{label}<select value={value} disabled={disabled} {...busySelect(busy??false)} onChange={e=>{if(!busy)onValue(Number(e.target.value));}}>{Object.entries(enumeration).filter(([,value])=>typeof value==='number').map(([name,value])=><option key={name} value={value}>{name.replace(/([a-z])([A-Z])/g,'$1 $2')}</option>)}</select></label>;
}
