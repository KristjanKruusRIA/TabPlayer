import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root=new URL('../',import.meta.url);
const {fonts}=JSON.parse(await readFile(new URL('assets/fonts/sources.json',root),'utf8'));
await mkdir(new URL('public/export-fonts/',root),{recursive:true});
for(const font of fonts) {
  const source=new URL(`assets/fonts/${font.filename}`,root);
  const bytes=await readFile(source);
  if(createHash('sha256').update(bytes).digest('hex')!==font.sha256)throw new Error(`Bundled export font hash mismatch: ${font.filename}`);
  await copyFile(source,new URL(`public/export-fonts/${font.filename}`,root));
}
