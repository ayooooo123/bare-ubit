// Runs ubit.wasm with only what it is handed: two folders, the standard streams, and outbound
// connections that the host makes on its behalf (public addresses only, by default).
import fs from 'bare-fs'
import { createWasi, ProcExit } from './lib/wasi.js'
import { createNet, isPublicAddress } from './lib/net.js'

export { isPublicAddress }

const PAGE = 65536
// linux/build_wasm.sh links with --initial-memory=16777216; an imported memory may not start smaller.
const INITIAL_PAGES = 16777216 / PAGE

let compiled = null
function module () {
  if (!compiled) compiled = new WebAssembly.Module(fs.readFileSync(decodeURIComponent(new URL('./ubit.wasm', import.meta.url).pathname)))
  return compiled
}

const writer = (fd) => (data) => { for (let off = 0; off < data.byteLength;) off += fs.writeSync(fd, data, off, data.byteLength - off) }

/**
 * Runs ubit with `args` (as after the program name) and resolves to its exit code.
 * `config` is the module's config and scratch folder (seen as /config, its HOME); `out`, if given, is seen as /out.
 * `allowAddress(ip)` decides which resolved addresses may be dialled; `onrefuse(host, addresses)` hears refusals.
 * `maxMemory` caps the module's memory in bytes (wasm32 allows at most 4 GiB; ubit reads a file it muxes whole).
 */
export async function run (args, {
  config,
  out = null,
  stdout = writer(1),
  stderr = writer(2),
  allowAddress = isPublicAddress,
  onrefuse = () => {},
  maxMemory = 4 * 1024 ** 3
} = {}) {
  if (!config) throw new Error('bare-ubit: a config folder is required')
  const memory = new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum: Math.max(INITIAL_PAGES, Math.floor(maxMemory / PAGE)) })
  const preopens = { '/config': config }
  if (out) preopens['/out'] = out
  const wasi = createWasi({
    memory: () => memory,
    args: ['ubit', ...args],
    env: { HOME: '/config', UBIT_CONFIG_DIR: '/config' },
    preopens,
    stdout,
    stderr
  })
  const net = createNet({ memory: () => memory, allowAddress, onrefuse })
  try {
    const instance = new WebAssembly.Instance(module(), {
      env: { memory },
      wasi_snapshot_preview1: wasi.imports,
      ubit_net: net.imports
    })
    await WebAssembly.promising(instance.exports._start)()
    return 0
  } catch (err) {
    if (err instanceof ProcExit) return err.code
    throw err
  } finally {
    net.destroy()
    wasi.destroy()
  }
}
