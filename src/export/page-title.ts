/** Keep the complete title in its existing single-line header. Fonts load before export. */
export function pageTitleFontSize(title:string,availableWidth:number,scale=1):number {return fitFontSize(title,availableWidth,18*scale);}
/** Shrinks single-line page text from its base size until it fits the available width. */
export function fitFontSize(title:string,availableWidth:number,base:number):number {
  const measuredWidth=measurePageText(title,base);
  return measuredWidth!==null&&measuredWidth>availableWidth?base*(availableWidth-1)/measuredWidth:base;
}
let cached:{owner:Document;context:CanvasRenderingContext2D}|null=null;
/** One measuring context is kept per document; a missing context is never cached. */
function measuringContext():CanvasRenderingContext2D|null {
  if(typeof document==='undefined')return null;
  if(cached?.owner===document)return cached.context;
  const context=document.createElement('canvas').getContext('2d');
  cached=context===null?null:{owner:document,context};
  return context;
}
/** Width of page text at a font size, or null where no canvas measures text (export runs in the webview). */
export function measurePageText(text:string,size:number):number|null {
  const context=measuringContext();
  if(context===null)return null;
  context.font=`${size}px "Noto Sans", "Noto Sans CJK JP", "Noto Emoji"`;
  return context.measureText(text).width;
}
