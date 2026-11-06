import { mkdir, copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const output=new URL('../public/licenses/',import.meta.url);await mkdir(output,{recursive:true});
const inventory=[];
async function collect(directory,name,version,license) {
  const destination=new URL(`${name.replaceAll('/','_')}-${version}/`,output);await mkdir(destination,{recursive:true});
  const files=(await readdir(directory)).filter(file=>/^(license|licence|copying|notice|authors)([.-]|$)/i.test(file));
  for(const file of files)await copyFile(join(directory,file),new URL(file,destination));
  inventory.push({name,version,license,files});
}
for(const name of ['@coderline/alphatab','@tauri-apps/api','@tauri-apps/plugin-dialog','react','react-dom','scheduler','fflate','@fontsource/instrument-sans','@fontsource/ibm-plex-mono']) {
  const directory=new URL(`../node_modules/${name}/`,import.meta.url);const pkg=JSON.parse(await readFile(new URL('package.json',directory),'utf8'));
  await collect(fileURLToPath(directory),name,pkg.version,pkg.license);
}
const cargo=process.platform==='win32'?join(process.env.USERPROFILE,'.cargo/bin/cargo.exe'):'cargo';
const metadata=JSON.parse(execFileSync(cargo,['metadata','--locked','--format-version','1','--manifest-path','src-tauri/Cargo.toml'],{encoding:'utf8',maxBuffer:10*1024*1024}));
for(const pkg of metadata.packages.filter(pkg=>pkg.source||pkg.name==='usvg'))await collect(dirname(pkg.manifest_path),pkg.name,pkg.version,pkg.license);
const audio=JSON.parse(await readFile(new URL('../assets/audio/sources.json',import.meta.url),'utf8'));
for(const source of audio.sources) {
  const destination=new URL(`audio/${source.id}/`,output);await mkdir(destination,{recursive:true});
  // An app-owned license is shipped from its pinned, byte-exact source.
  await copyFile(new URL(source.localRoot?`../assets/audio/${source.localRoot}/${source.licensePath}`:`../assets/audio/licenses/${source.id}.txt`,import.meta.url),new URL('LICENSE.txt',destination));
  await copyFile(new URL(`../assets/audio/${source.inventoryPath}`,import.meta.url),new URL('source-inventory.json',destination));
  inventory.push({name:source.repository,version:source.revision,license:source.license,files:[`audio/${source.id}/LICENSE.txt`,`audio/${source.id}/source-inventory.json`]});
}
await copyFile(new URL('../assets/audio/sources.json',import.meta.url),new URL('audio/sources.json',output));
const fonts=new URL('export-fonts/',output);await mkdir(fonts,{recursive:true});
const fontSources=JSON.parse(await readFile(new URL('../assets/fonts/sources.json',import.meta.url),'utf8'));
for(const name of new Set([...fontSources.fonts.map(font=>font.licenseFile),'sources.json']))await copyFile(new URL(`../assets/fonts/${name}`,import.meta.url),new URL(name,fonts));
await writeFile(new URL('packages.json',output),JSON.stringify(inventory,null,2));
await copyFile(new URL('../THIRD_PARTY_NOTICES.md',import.meta.url),new URL('THIRD_PARTY_NOTICES.md',output));
await copyFile(new URL('../legal/Apache-2.0.txt',import.meta.url),new URL('Apache-2.0.txt',output));
await copyFile(new URL('../legal/integrated-notices.txt',import.meta.url),new URL('integrated-notices.txt',output));
