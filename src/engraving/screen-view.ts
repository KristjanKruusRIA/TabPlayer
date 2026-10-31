export type ScoreLayoutMode='verticalPage'|'horizontalPage'|'grid'|'parchment'|'verticalScreen'|'horizontalScreen';
export type ScoreZoomMode='manual'|'fitWidth'|'fitPage';
export interface ScoreDisplayPreferences {layout:ScoreLayoutMode;zoomMode:ScoreZoomMode}

export function isPhysicalPageLayout(layout:ScoreLayoutMode):boolean {
  return layout==='verticalPage'||layout==='horizontalPage'||layout==='grid';
}

export function repairScoreDisplay(value:unknown):ScoreDisplayPreferences|undefined {
  if(value===null||typeof value!=='object'||Array.isArray(value))return undefined;
  const keys=Reflect.ownKeys(value);
  if(keys.length!==2||!keys.includes('layout')||!keys.includes('zoomMode'))return undefined;
  const {layout,zoomMode}=value as Record<string,unknown>;
  if(layout!=='verticalPage'&&layout!=='horizontalPage'&&layout!=='grid'&&layout!=='parchment'&&layout!=='verticalScreen'&&layout!=='horizontalScreen')return undefined;
  if(zoomMode!=='manual'&&zoomMode!=='fitWidth'&&zoomMode!=='fitPage')return undefined;
  return {layout,zoomMode:zoomMode==='fitPage'&&!isPhysicalPageLayout(layout)?'fitWidth':zoomMode};
}

export function resolveScoreDisplay(value:unknown):ScoreDisplayPreferences {
  return repairScoreDisplay(value) ?? {layout:'parchment',zoomMode:'manual'};
}
