/** Keep the complete title in its existing single-line header. Fonts load before export. */
export function pageTitleFontSize(title:string,availableWidth:number):number {
  if(typeof document==='undefined')return 18;
  const context=document.createElement('canvas').getContext('2d')!;
  context.font='18px "Noto Sans", "Noto Sans CJK JP", "Noto Emoji"';
  const measuredWidth=context.measureText(title).width;
  return measuredWidth>availableWidth?18*(availableWidth-1)/measuredWidth:18;
}
