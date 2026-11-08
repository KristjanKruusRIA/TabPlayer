import { createRequire } from 'node:module';

// The desktop WebView supplies these. Node tests need the same XML DOM surface.
// Loading jsdom costs about 0.7 s of CPU, and this file runs before every one of the 353 test files, so the window is built
// on first use instead of up front. A test file that needs no XML now starts in 0.3 s instead of 1.1 s
// (docs/validation/2026-11-08-the-173-app-mount-tests.md has the measurements).
// Reading either global builds the one shared window, and the global that was read becomes a plain property, as it was before.
if(typeof globalThis.DOMParser==='undefined') {
  const require=createRequire(import.meta.url);
  let window;
  const provide=name=>{
    const settle=value=>Object.defineProperty(globalThis,name,{value,writable:true,enumerable:true,configurable:true});
    Object.defineProperty(globalThis,name,{
      enumerable:true,configurable:true,
      get(){window??=new (require('jsdom').JSDOM)('').window;const value=window[name];settle(value);return value;},
      set:settle,
    });
  };
  provide('DOMParser');provide('XMLSerializer');
}
