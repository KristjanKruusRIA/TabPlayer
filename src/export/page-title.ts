import { fontStack } from '../engraving/font-catalog';

/** How page text is measured: a chosen role's alias (null for the default Noto stack), weight and slant. */
export interface PageTextFont {family:string|null;bold:boolean;italic:boolean}
/** Keep the complete title in its existing single-line header. Fonts load before export. */
export function pageTitleFontSize(title:string,availableWidth:number,scale=1,font?:PageTextFont):number {return fitFontSize(title,availableWidth,18*scale,font);}
/** Shrinks single-line page text from its base size until it fits the available width. */
export function fitFontSize(title:string,availableWidth:number,base:number,font?:PageTextFont):number {
  const measuredWidth=measurePageText(title,base,font);
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
export function measurePageText(text:string,size:number,font?:PageTextFont):number|null {
  const context=measuringContext();
  if(context===null)return null;
  // Without a font the string is the one measured before roles existed.
  context.font=`${font?.italic?'italic ':''}${font?.bold?'bold ':''}${size}px ${fontStack(font?.family??null).map(family=>`"${family}"`).join(', ')}`;
  return context.measureText(text).width;
}
