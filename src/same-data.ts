/** Structural equality of plain data (primitives, arrays, plain objects), as native status is. */
export function sameData(a:unknown,b:unknown):boolean{
  if(Object.is(a,b))return true;
  if(typeof a!=='object'||typeof b!=='object'||a===null||b===null)return false;
  if(Array.isArray(a)){if(!Array.isArray(b)||a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(!sameData(a[i],b[i]))return false;return true;}
  if(Array.isArray(b))return false;
  // Native status and settings are plain JSON, which has no Map or Set; one that does turn up is compared by its entries (keys by identity) rather than taken for an empty object.
  if(a instanceof Map||b instanceof Map){
    if(!(a instanceof Map&&b instanceof Map)||a.size!==b.size)return false;
    for(const [key,value] of a)if(!b.has(key)||!sameData(value,b.get(key)))return false;
    return true;
  }
  if(a instanceof Set||b instanceof Set){
    if(!(a instanceof Set&&b instanceof Set)||a.size!==b.size)return false;
    for(const item of a)if(!b.has(item))return false;
    return true;
  }
  const ka=Object.keys(a),kb=Object.keys(b);if(ka.length!==kb.length)return false;
  for(const key of ka){if(!Object.hasOwn(b,key)||!sameData((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key]))return false;}
  return true;
}
