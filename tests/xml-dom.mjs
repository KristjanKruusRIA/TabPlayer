import { JSDOM } from 'jsdom';

// The desktop WebView supplies these. Node tests need the same XML DOM surface.
if(typeof globalThis.DOMParser==='undefined') {
  const {window}=new JSDOM('');
  globalThis.DOMParser=window.DOMParser;
  globalThis.XMLSerializer=window.XMLSerializer;
}
