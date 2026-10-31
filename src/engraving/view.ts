export type TrackView={kind:'selected'}|{kind:'all'}|{kind:'custom';trackIds:string[]};

export function resolveVisibleTracks(ids:readonly string[],selected:number,view:TrackView):number[] {
  const visible=ids.flatMap((id,index)=>view.kind==='all'||view.kind==='custom'&&view.trackIds.includes(id)?[index]:[]);
  return visible.length?visible:ids.length?[selected]:[];
}
