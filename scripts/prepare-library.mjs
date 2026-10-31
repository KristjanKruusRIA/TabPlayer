import {lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,join,parse,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const templateIds=['factory-guitar-6','factory-guitar-7','factory-guitar-8','factory-guitar-9','factory-bass-4','factory-bass-5','factory-bass-6','factory-keys','factory-drums','factory-band'];
const exampleIds=['example-windowline','example-seven-steps-five-echoes','example-lantern-counterpoint'];
const documentPaths=['README.md','CC0-1.0.txt'];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,fields)=>object(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const text=value=>typeof value==='string'&&value.trim().length>0&&value.length<=2048;

function validateManifest(manifest){
  if(!exact(manifest,['format','version','templates','examples','documents'])||manifest.format!=='TabPlayerBundledLibrary'||manifest.version!==1)throw new Error('Unsupported bundled library manifest.');
  const ids=new Set(),paths=new Set();
  for(const [kind,known,origin] of [['templates',templateIds,'factory'],['examples',exampleIds,'example']]){
    if(!Array.isArray(manifest[kind])||manifest[kind].length!==known.length)throw new Error(`Missing or unknown ${kind} inventory.`);
    for(const item of manifest[kind]){
      if(!exact(item,['id','title','description','instruments','origin','license','sha256','path'])||!known.includes(item.id)||ids.has(item.id))throw new Error('Unknown or duplicate library descriptor ID/fields.');
      if(item.path!==`${kind}/${item.id}.tabplayer`||paths.has(item.path))throw new Error('Unknown or unsafe library resource path.');
      if(!text(item.title)||!text(item.description)||!Array.isArray(item.instruments)||item.instruments.length<1||item.instruments.length>16||!item.instruments.every(text)||item.origin!==origin||item.license!=='CC0-1.0'||!digest(item.sha256))throw new Error('Invalid bundled library descriptor metadata/hash.');
      ids.add(item.id);paths.add(item.path);
    }
  }
  if(!Array.isArray(manifest.documents)||manifest.documents.length!==documentPaths.length)throw new Error('Missing library dedication/license inventory.');
  for(const item of manifest.documents){
    if(!exact(item,['path','sha256'])||!documentPaths.includes(item.path)||paths.has(item.path)||!digest(item.sha256))throw new Error('Invalid or duplicate library document resource path/hash.');
    paths.add(item.path);
  }
  return [...manifest.templates,...manifest.examples,...manifest.documents];
}

// Inspect each existing path component so directory junctions cannot bypass the
// regular-file boundary. Missing destination components are created only later.
async function inspect(path,directory,allowMissing=false){
  const absolute=resolve(path),root=parse(absolute).root,parts=absolute.slice(root.length).split(sep).filter(Boolean);
  let current=root;
  for(const [index,part] of parts.entries()){
    current=join(current,part);let info;
    try{info=await lstat(current);}catch(error){if(error.code==='ENOENT'&&allowMissing)return false;if(error.code==='ENOENT')throw new Error(`Missing library resource: ${path}`);throw error;}
    if(info.isSymbolicLink())throw new Error(`Library symlink resource is not allowed: ${current}`);
    if(index<parts.length-1||directory){if(!info.isDirectory())throw new Error(`Library resource directory is not regular: ${current}`);}
    else if(!info.isFile())throw new Error(`Library resource must be a regular file: ${current}`);
  }
  return true;
}

const contains=(parent,child)=>{const path=relative(parent,child);return !path||(!isAbsolute(path)&&path!=='..'&&!path.startsWith(`..${sep}`));};

export async function prepareLibrary({source=fileURLToPath(new URL('../assets/library/',import.meta.url)),destination,checkOnly=false}={}){
  if(typeof destination!=='string'||!destination)throw new Error('A library destination directory is required.');
  if(typeof source!=='string'||!source||typeof checkOnly!=='boolean')throw new Error('Invalid library preparation options.');
  source=resolve(source);destination=resolve(destination);
  if(contains(source,destination)||contains(destination,source))throw new Error('Library source and destination must not overlap.');
  await inspect(source,true);await inspect(destination,true,true);
  const manifestPath=join(source,'manifest.json');await inspect(manifestPath,false);
  const manifestBytes=await readFile(manifestPath),manifest=JSON.parse(manifestBytes.toString('utf8')),entries=validateManifest(manifest),resources=[];
  // Validate the entire input and every output path before the first write.
  for(const item of entries){const path=join(source,item.path);await inspect(path,false);const bytes=await readFile(path);if(sha256(bytes)!==item.sha256)throw new Error(`Library source hash mismatch: ${item.path}`);resources.push({path:item.path,bytes});}
  resources.push({path:'manifest.json',bytes:manifestBytes});
  for(const item of resources)await inspect(join(destination,item.path),false,true);
  if(checkOnly){
    for(const item of resources){const path=join(destination,item.path);if(!await inspect(path,false,true))throw new Error(`Missing prepared library resource: ${item.path}`);if(!item.bytes.equals(await readFile(path)))throw new Error(`Stale prepared library hash: ${item.path}`);}
  }else{
    for(const item of resources){const path=join(destination,item.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,item.bytes);}
  }
  return {manifest,files:resources.map(item=>item.path)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2),options={};
  while(args.length){const arg=args.shift();if(arg==='--check')options.checkOnly=true;else if(arg==='--source'||arg==='--destination'){const value=args.shift();if(!value||value.startsWith('--'))throw new Error(`Missing value for ${arg}`);options[arg==='--source'?'source':'destination']=value;}else throw new Error(`Unknown library preparation argument: ${arg}`);}
  if(options.destination){const result=await prepareLibrary(options);console.log(`${options.checkOnly?'Verified':'Prepared'} offline library: ${result.files.length} files`);}
  else for(const path of ['../public/library/','../src-tauri/resources/library/']){const result=await prepareLibrary({...options,destination:fileURLToPath(new URL(path,import.meta.url))});console.log(`${options.checkOnly?'Verified':'Prepared'} offline library: ${result.files.length} files`);}
}
