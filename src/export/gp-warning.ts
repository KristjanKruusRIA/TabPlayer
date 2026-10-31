/** The question asked before a Guitar Pro 7/8 export that has to leave something out. Shared by the app paths and the batch note. */
export function gpWarning(losses:string[]):{title:string;message:string} {
  return {title:'Export Guitar Pro file',message:`Guitar Pro export rebuilds the score. Some techniques, layout, or sound settings may change. Left out of this file: ${losses.slice(0,5).join('; ')}${losses.length>5?`; and ${losses.length-5} more`:''}. Your native project and original file are preserved.`};
}
