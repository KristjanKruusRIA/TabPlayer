// @vitest-environment jsdom
import { it } from 'vitest';
import { writeKitFiles } from './gp8-acceptance-families';

// Opt-in: `node scripts/gp8-acceptance-kit.mjs write [dir]` runs this file with GP8_KIT_OUT set. Without it the test is skipped, so the
// normal suite writes nothing.
const out = process.env.GP8_KIT_OUT;
it.skipIf(!out)('writes the Guitar Pro 8 acceptance kit into GP8_KIT_OUT', () => {
  writeKitFiles(out!);
});
