#!/usr/bin/env bare
// bare-ubit [--config DIR] [--allow-private] <ubit arguments>
// Same commands, flags and NDJSON as `ubit`; `-o DIR` is the only host folder besides the config folder it can touch.
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { run, isPublicAddress } from './index.js'

const argv = Bare.argv.slice(2)
let config = os.getEnv('UBIT_CONFIG_DIR') || path.join(os.homedir(), '.config', 'uBit')
let allowPrivate = false
const args = []
let out = null
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--config') config = argv[++i]
  else if (a === '--allow-private') allowPrivate = true
  else if ((a === '-o' || a === '--output') && i + 1 < argv.length) {
    out = path.resolve(argv[++i])
    args.push(a, '/out')
  } else args.push(a)
}
// Without -o, `get` saves where ubit would: ~/Downloads.
if (!out && args[0] === 'get') {
  out = path.join(os.homedir(), 'Downloads')
  args.push('-o', '/out')
}

// ubit reports where it saved as /out/…; print the host path, so callers of `ubit --json` / `--quiet` need no change.
const toHost = (p) => (out && typeof p === 'string' && p.startsWith('/out/')) ? path.join(out, p.slice(5)) : p
const print = (s) => { const b = Buffer.from(s); for (let off = 0; off < b.byteLength;) off += fs.writeSync(1, b, off, b.byteLength - off) }
let pending = ''
function stdout (data) {
  pending += Buffer.from(data).toString()
  let nl
  while ((nl = pending.indexOf('\n')) !== -1) {
    let line = pending.slice(0, nl)
    pending = pending.slice(nl + 1)
    if (line.startsWith('{')) {
      try {
        const ev = JSON.parse(line)
        if ('path' in ev) { ev.path = toHost(ev.path); line = JSON.stringify(ev) }
      } catch {}
    } else {
      line = toHost(line)
    }
    print(line + '\n')
  }
}

run(args, {
  config: path.resolve(config),
  out,
  stdout,
  allowAddress: allowPrivate ? () => true : isPublicAddress,
  onrefuse: (host, addresses) => console.error(`bare-ubit: refused ${host} (${addresses.join(', ') || 'no address'})`)
}).then(code => {
  if (pending) print(toHost(pending))
  Bare.exitCode = code
}, err => {
  console.error(err)
  Bare.exitCode = 1
})
