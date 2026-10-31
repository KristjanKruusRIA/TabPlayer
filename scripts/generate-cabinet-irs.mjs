// Rebuilds src-tauri/resources/cabinet-irs/manifest.json from the bundled WAVs.
// The WAVs are CC0 captures from the tabplayer-ir-packs set; this script only
// derives display names, identities and integrity hashes. It never downloads
// anything and never renames a file.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));

export const packs = [
  { id: 'tabplayer-bass-amp', name: 'Bass Amp' },
  { id: 'tabplayer-dt', name: 'DT410' },
  { id: 'tabplayer-fender', name: 'Fender' },
  { id: 'tabplayer-mesa', name: 'Mesa V30 4x12' },
  { id: 'tabplayer-recto', name: 'Recto V30' },
  { id: 'tabplayer-zilla', name: 'Zilla V30 2x12' },
];

// Two legacy file names do not start with their pack id.
const packOverrides = {
  'tabplayer-fende-oxford-lean-48-24-220917': { pack: 'tabplayer-fender', tail: 'oxford-lean-48-24-220917' },
  'tabplayer-zilla-v30-2x12-zilla-v30-2-x12-shuresm57-3-dc-71294': { pack: 'tabplayer-zilla', tail: 'shuresm57-3-dc-71294' },
};

const words = {
  ampeg: 'Ampeg', svt: 'SVT', svt18e: 'SVT18E', mesa: 'Mesa', boogie: 'Boogie',
  fender: 'Fender', bassman: 'Bassman', jbl: 'JBL', leslie: 'Leslie', hf: 'HF',
  swr: 'SWR', sunn: 'Sunn', coliseum: 'Coliseum', trace: 'Trace', elliot: 'Elliot',
  goliath: 'Goliath', marshall: 'Marshall', polytone: 'Polytone', a101: 'A101',
  vox: 'Vox', ac100: 'AC100', b15: 'B15', w: 'with',
};
const titleCase = token => words[token] ?? (token.length > 2 ? token[0].toUpperCase() + token.slice(1) : token);

const positions = { ll: 'Lower left', lr: 'Lower right', ul: 'Upper left', ur: 'Upper right' };
const mics = {
  '57': 'SM57', sm57: 'SM57', '4033': '4033', d6: 'D6', e602: 'E602',
  sa73: 'SA73', vp28: 'VP28', cl7603: 'CL7603', '7603': '7603',
  neumannu87: 'Neumann U87', royerr101: 'Royer R-101',
  sennheisermd421: 'Sennheiser MD421', shuresm57: 'Shure SM57',
};
const mic = token => mics[token] ?? titleCase(token);
const inches = token => {
  const match = /^(\d+)-(\d+)in$/.exec(token);
  return match ? `${match[1]}.${match[2]}in` : token;
};

export function describe(pack, tail) {
  const parts = tail.split('-');
  switch (pack) {
    case 'tabplayer-mesa': {
      // v30-<position>-4fb-4x12-sm57-<distance>in-0-0in-<mic>-<capture>
      const [, position, , , closeMic, distanceA, distanceB, , , farMic] = parts;
      return `${positions[position] ?? position} · ${mic(closeMic)} ${inches(`${distanceA}-${distanceB}`)} · ${mic(farMic)}`;
    }
    case 'tabplayer-dt': {
      // eden-4x10-<mic>-<preset>-<capture>
      const [, cab, closeMic, preset] = parts;
      return `Eden ${cab} · ${mic(closeMic)} · ${preset.toUpperCase()}`;
    }
    case 'tabplayer-fender': {
      // oxford-<voicing>[-48-24]-<capture>
      const voicing = parts.slice(0, 2).map(titleCase).join(' ');
      return parts.includes('48') ? `${voicing} (48/24)` : voicing;
    }
    case 'tabplayer-bass-amp': {
      // <index>-<cab>-<description>-dc-<capture>
      return parts.slice(1, parts.indexOf('dc')).map(titleCase).join(' ');
    }
    case 'tabplayer-zilla': {
      // <mic>-<position>-dc-<capture>
      return `${mic(parts[0])} · pos ${parts[1]} · DC`;
    }
    default:
      return pack === 'tabplayer-recto' ? 'Recto V30' : tail.replaceAll('-', ' ');
  }
}

/** A name the picker and a document can both hold: pack, then what was captured. */
export function displayName(packName, label) {
  const name = label === packName || label.startsWith(`${packName} `) ? label : `${packName} · ${label}`;
  return name.slice(0, 64).trim();
}

function wavFormat(bytes) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      return {
        channels: bytes.readUInt16LE(offset + 10),
        sampleRate: bytes.readUInt32LE(offset + 12),
        blockAlign: bytes.readUInt16LE(offset + 20),
      };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('Missing WAV fmt chunk');
}

function wavFrames(bytes) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') return { frames: size, offset: offset + 8 };
    offset += 8 + size + (size % 2);
  }
  throw new Error('Missing WAV data chunk');
}

export async function generate({ directory = join(repository, 'src-tauri/resources/cabinet-irs'), write = true } = {}) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.wav')).sort();
  const entries = [];
  for (const file of names) {
    const bytes = await readFile(join(directory, file));
    const stem = file.slice(0, -4);
    const override = packOverrides[stem];
    const pack = override?.pack ?? packs.map(p => p.id).sort((a, b) => b.length - a.length).find(candidate => stem === candidate || stem.startsWith(`${candidate}-`));
    if (!pack) throw new Error(`Unknown IR pack for ${file}`);
    const format = wavFormat(bytes);
    const data = wavFrames(bytes);
    const tail = override?.tail ?? (stem === pack ? '' : stem.slice(pack.length + 1));
    const packName = packs.find(p => p.id === pack).name;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    entries.push({
      id: sha256.slice(0, 32),
      name: displayName(packName, describe(pack, tail)),
      file,
      sha256,
      size: bytes.length,
      sampleRate: format.sampleRate,
      channels: format.channels,
      frames: format.blockAlign ? Math.floor(data.frames / format.blockAlign) : 0,
    });
  }
  const order = new Map(packs.map((p, index) => [p.id, index]));
  entries.sort((a, b) => order.get(a.pack) - order.get(b.pack) || a.id.localeCompare(b.id));
  const ids = new Set(entries.map(entry => entry.id));
  if (ids.size !== entries.length) throw new Error('Two bundled IRs have the same identity');
  const manifest = {
    schemaVersion: 1,
    license: 'CC0-1.0',
    licenseFile: 'LICENSE-CC0.txt',
    source: 'tabplayer-ir-packs',
    irs: entries,
  };
  if (write) await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const manifest = await generate();
  console.log(`Wrote ${manifest.irs.length} IRs to src-tauri/resources/cabinet-irs/manifest.json`);
}
