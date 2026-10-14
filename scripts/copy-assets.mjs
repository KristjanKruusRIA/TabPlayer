import { mkdir, copyFile, readdir } from 'node:fs/promises';

const distribution = new URL('../node_modules/@coderline/alphatab/dist/', import.meta.url);
for (const folder of ['font','soundfont']) {
  const source = new URL(`${folder}/`, distribution);
  const destination = new URL(`../public/${folder}/`, import.meta.url);
  await mkdir(destination,{recursive:true});
  for (const name of await readdir(source)) await copyFile(new URL(name,source),new URL(name,destination));
}
const destination = new URL('../public/alphatab/',import.meta.url);
await mkdir(destination,{recursive:true});
for (const name of ['alphaTab.mjs','alphaTab.core.mjs','alphaTab.worker.mjs','alphaTab.worklet.mjs']) {
  await copyFile(new URL(name,distribution),new URL(name,destination));
}
await copyFile(new URL('../LICENSE',distribution),new URL('LICENSE',destination));
await copyFile(new URL('../LICENSE.header',distribution),new URL('LICENSE.header',destination));
