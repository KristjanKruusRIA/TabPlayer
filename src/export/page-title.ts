/** Keep the complete title in its existing single-line header. Fonts load before export. */
export function pageTitleFontSize(title:string,availableWidth:number):number {return fitFontSize(title,availableWidth,18);}
/** Shrinks single-line page text from its base size until it fits the available width. */
export function fitFontSize(title:string,availableWidth:number,base:number):number {
  const measuredWidth=measurePageText(title,base);
  return measuredWidth!==null&&measuredWidth>availableWidth?base*(availableWidth-1)/measuredWidth:base;
}
/** Width of page text at a font size, or null where no canvas measures text (export runs in the webview). */
export function measurePageText(text:string,size:number):number|null {
  if(typeof document==='undefined')return null;
  const context=document.createElement('canvas').getContext('2d')!;
  context.font=`${size}px "Noto Sans", "Noto Sans CJK JP", "Noto Emoji"`;
  return context.measureText(text).width;
}
