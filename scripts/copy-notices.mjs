import { access, mkdir, copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const output=new URL('../public/licenses/',import.meta.url);await mkdir(output,{recursive:true});
const inventory=[];
async function collect(directory,name,version,license) {
  const destination=new URL(`${name.replaceAll('/','_')}-${version}/`,output);await mkdir(destination,{recursive:true});
  const files=(await readdir(directory)).filter(file=>/^(license|licence|copying|notice|authors)([.-]|$)/i.test(file));
  for(const file of files)await copyFile(join(directory,file),new URL(file,destination));
  // A crate that builds bundled C sources keeps their licenses in its `*_vendor` folders, as the Ogg and Vorbis crates do,
  // or in the source folder itself, as mp3lame-sys does with `lame-3.100`.
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(!entry.isDirectory()||!(entry.name.endsWith('_vendor')||/^lame-\d/.test(entry.name)))continue;
    for(const file of (await readdir(join(directory,entry.name))).filter(file=>/^(license|licence|copying)([.-]|$)/i.test(file))) {
      const named=`${entry.name}-${file}`;await copyFile(join(directory,entry.name,file),new URL(named,destination));files.push(named);
    }
  }
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
  // An app-owned license is shipped from its pinned, byte-exact source; one the repository holds, from its recorded copy.
  const owned=source.localRoot?new URL(`../assets/audio/${source.localRoot}/${source.licensePath}`,import.meta.url):null;
  const local=owned&&await access(owned).then(()=>true,()=>false);
  await copyFile(local?owned:new URL(`../assets/audio/licenses/${source.id}.txt`,import.meta.url),new URL('LICENSE.txt',destination));
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
// The vorbis-rs crates publish no licence file, so their upstream BSD-3-Clause text is kept in the repository.
await copyFile(new URL('../legal/vorbis-rs-BSD-3-Clause.txt',import.meta.url),new URL('vorbis-rs-BSD-3-Clause.txt',output));
// The basic-udev crate (the Linux backend of hidapi) ships no licence file, so its MIT text is kept in the repository.
await copyFile(new URL('../legal/basic-udev-MIT.txt',import.meta.url),new URL('basic-udev-MIT.txt',output));
// VST3 hosting: the `vst3` crate's licences are packaged with the crate; `com-scrape-types` publishes no licence file, the
// Steinberg interfaces the bindings are generated from are MIT, and the plug-in helper vendors a part of SoundCraft's FFI
// (its bundle resolution is in the protocol crate, so the app binary links that part too).
for(const name of ['steinberg-pluginterfaces-MIT.txt','com-scrape-types-MIT.txt','soundcraft-vst3-host-MIT.txt'])await copyFile(new URL(`../legal/${name}`,import.meta.url),new URL(name,output));
// The hidapi crate builds the bundled C HIDAPI on macOS only; its BSD-style licence is kept in the repository (Fretlight, THE-77).
await copyFile(new URL('../legal/hidapi-bsd-license.txt',import.meta.url),new URL('hidapi-bsd-license.txt',output));
// The LGPL-3.0 of mp3lame-sys asks for the GNU GPL 3.0 text to travel with it.
await copyFile(new URL('../legal/GPL-3.0.txt',import.meta.url),new URL('GPL-3.0.txt',output));
