// Tests run under plain Node: code imports electron (via store.ts, oauth.ts) but tests never use the real thing.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Settings and data go to an empty folder per test run, so defaults apply
const dir = mkdtempSync(join(tmpdir(), 'letterwing-test-'))
export const app = { getPath: () => dir }
export const safeStorage = {}
export const shell = { openExternal: async () => {} }
