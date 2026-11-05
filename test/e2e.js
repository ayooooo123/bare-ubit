// bare test/e2e.js — ubit.wasm against a local server, plus the sandbox's edges. Needs ffmpeg and ffprobe.
// Writes test/e2e-result.json.
import assert from 'bare-assert'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import http from 'bare-http1'
import { spawnSync } from 'bare-subprocess'
import { run, isPublicAddress } from '../index.js'
import { createWasi } from '../lib/wasi.js'

const same = (got, want, msg) => assert.equal(JSON.stringify(got), JSON.stringify(want), msg)
const results = []
async function check (name, fn) {
  const t = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true, ms: Date.now() - t, ...(detail ? { detail } : {}) })
    console.log('ok', name)
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.stack || err) })
    console.log('FAIL', name, err)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-ubit-'))
const fixtures = path.join(tmp, 'fixtures')
fs.mkdirSync(path.join(fixtures, 'hls'), { recursive: true })
fs.mkdirSync(path.join(fixtures, 'big'), { recursive: true })

function sh (cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) throw new Error(cmd + ' failed: ' + Buffer.from(r.stderr || '').toString())
  return Buffer.from(r.stdout || '').toString()
}
function probe (file) {
  const j = JSON.parse(sh('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', file]))
  return { duration: Number(j.format.duration), streams: j.streams.map(s => s.codec_type + ':' + s.codec_name).sort() }
}

const src = ['-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4']
const enc = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']
sh('ffmpeg', ['-y', '-v', 'error', ...src, ...enc, '-movflags', '+faststart', path.join(fixtures, 'clip.mp4')])
// AES-128 HLS: key served beside the playlist, so the module must fetch and decrypt it.
fs.writeFileSync(path.join(fixtures, 'hls', 'key.bin'), Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'))
fs.writeFileSync(path.join(fixtures, 'keyinfo'), 'key.bin\n' + path.join(fixtures, 'hls', 'key.bin') + '\n')
sh('ffmpeg', ['-y', '-v', 'error', ...src, ...enc, '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
  '-hls_key_info_file', path.join(fixtures, 'keyinfo'), '-hls_segment_filename', path.join(fixtures, 'hls', 'seg%03d.ts'), path.join(fixtures, 'hls', 'index.m3u8')])
// About 30 MB of segments: more than the 24 MiB memory cap used below.
sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=8:size=1920x1080:rate=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '30M', '-maxrate', '30M', '-bufsize', '30M',
  '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(fixtures, 'big', 'seg%03d.ts'), path.join(fixtures, 'big', 'index.m3u8')])

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (url === '/redirect-private') {
    res.statusCode = 302
    res.setHeader('Location', `http://127.0.0.2:${port}/clip.mp4`)
    return res.end()
  }
  const file = path.join(fixtures, path.normalize(url).replace(/^(\.\.[/\\])+/, ''))
  let st
  try { st = fs.statSync(file) } catch { res.statusCode = 404; return res.end() }
  if (!st.isFile()) { res.statusCode = 404; return res.end() }
  const data = fs.readFileSync(file)
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
  res.setHeader('Content-Type', file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream')
  if (range) {
    const start = Number(range[1])
    const end = Math.min(range[2] ? Number(range[2]) : data.byteLength - 1, data.byteLength - 1)
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${data.byteLength}`)
    res.setHeader('Content-Length', end - start + 1)
    return res.end(data.subarray(start, end + 1))
  }
  res.setHeader('Content-Length', data.byteLength)
  res.end(data)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
const onlyLoopback = (ip) => ip === '127.0.0.1'

let n = 0
async function ubit (args, opts = {}) {
  const dir = path.join(tmp, 'run' + (++n))
  const out = path.join(dir, 'out')
  const lines = []
  const refused = []
  let buf = ''
  const code = await run(args, {
    config: path.join(dir, 'config'),
    out,
    stdout: (d) => { buf += Buffer.from(d).toString() },
    stderr: () => {},
    onrefuse: (host, addrs) => refused.push({ host, addrs }),
    ...opts
  })
  for (const l of buf.split('\n')) if (l.startsWith('{')) lines.push(JSON.parse(l))
  const files = fs.existsSync(out) ? fs.readdirSync(out) : []
  return { code, events: lines, refused, out, files }
}

await check('addresses: only globally routable unicast passes', () => {
  const cases = {
    '8.8.8.8': true, '1.1.1.1': true, '2606:4700:4700::1111': true, '::ffff:8.8.8.8': true,
    '127.0.0.1': false, '10.1.2.3': false, '172.16.0.1': false, '192.168.1.1': false, '169.254.169.254': false,
    '100.64.0.1': false, '0.0.0.0': false, '224.0.0.251': false, '::1': false, '::': false, 'fe80::1': false,
    'fd00::1': false, 'ff02::1': false, '::ffff:127.0.0.1': false, '::ffff:10.0.0.1': false,
    '64:ff9b::a00:1': false, '2002:7f00:1::': false, '2001:db8::1': false, 'not-an-ip': false,
    '64:ff9b:1::1': false, '64:ff9b:1:ffff:ffff:ffff:ffff:ffff': false, '3fff::1': false, '3fff:fff:ffff::1': false,
    '5f00::1': false, '64:ff9b::808:808': true
  }
  for (const [ip, want] of Object.entries(cases)) assert.equal(isPublicAddress(ip), want, ip)
})

await check('files: nothing outside the preopened folder can be named', () => {
  const root = path.join(tmp, 'jail', 'root')
  const outside = path.join(tmp, 'jail', 'outside')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(root, 'inside.txt'), 'in')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  fs.symlinkSync(outside, path.join(root, 'link'))
  const memory = new WebAssembly.Memory({ initial: 1 })
  const { imports } = createWasi({ memory: () => memory, args: [], preopens: { '/out': root } })
  const put = (s) => { const b = Buffer.from(s); new Uint8Array(memory.buffer).set(b, 1024); return [1024, b.byteLength] }
  const open = (p, oflags = 0) => imports.path_open(3, 0, ...put(p), oflags, (1n << 1n) | (1n << 6n), 0n, 0, 0)
  const NOTCAPABLE = 76
  assert.equal(open('inside.txt'), 0)
  for (const p of ['../outside/secret.txt', '/etc/passwd', 'a/../../outside/secret.txt', 'link/secret.txt', 'link']) assert.equal(open(p), NOTCAPABLE, p)
  assert.equal(open('link/new.txt', 1), NOTCAPABLE) // O_CREAT through the link
  assert.equal(imports.path_create_directory(3, ...put('link/made')), NOTCAPABLE)
  assert.equal(imports.path_unlink_file(3, ...put('link/secret.txt')), NOTCAPABLE)
  const [fp, fl] = put('inside.txt')
  const to = Buffer.from('../stolen.txt')
  new Uint8Array(memory.buffer).set(to, 2048)
  assert.equal(imports.path_rename(3, fp, fl, 3, 2048, to.byteLength), NOTCAPABLE)
  same(fs.readdirSync(outside), ['secret.txt'])
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret')
})

await check('network: a private address is refused by default', async () => {
  const r = await ubit(['get', base + '/clip.mp4', '--no-library', '--json', '-o', '/out'])
  assert.notEqual(r.code, 0)
  assert.ok(r.refused.some(x => x.host === '127.0.0.1'), JSON.stringify(r.refused))
  same(r.files, [])
  return { code: r.code, refused: r.refused }
})

await check('network: a redirect to another private address is refused', async () => {
  const r = await ubit(['get', base + '/redirect-private', '--no-library', '--json', '-o', '/out'], { allowAddress: onlyLoopback })
  assert.notEqual(r.code, 0)
  assert.ok(r.refused.some(x => x.host === '127.0.0.2'), JSON.stringify(r.refused))
  same(r.files, [])
  return { code: r.code, refused: r.refused }
})

await check('download: a direct MP4 arrives whole', async () => {
  const r = await ubit(['get', base + '/clip.mp4', '--no-library', '--json', '-o', '/out'], { allowAddress: onlyLoopback })
  assert.equal(r.code, 0, JSON.stringify(r.events.at(-1)))
  const done = r.events.find(e => e.event === 'done')
  assert.ok(done && done.path.startsWith('/out/'), JSON.stringify(done))
  const got = probe(path.join(r.out, done.path.slice(5)))
  const want = probe(path.join(fixtures, 'clip.mp4'))
  same(got.streams, want.streams)
  assert.ok(Math.abs(got.duration - want.duration) < 0.1, JSON.stringify({ got, want }))
  return { file: done.path, size: done.size, ...got }
})

await check('download: AES-128 HLS is decrypted and muxed to MP4', async () => {
  const r = await ubit(['get', base + '/hls/index.m3u8', '--no-library', '--json', '-o', '/out'], { allowAddress: onlyLoopback })
  assert.equal(r.code, 0, JSON.stringify(r.events.at(-1)))
  const done = r.events.find(e => e.event === 'done')
  const got = probe(path.join(r.out, done.path.slice(5)))
  same(got.streams, ['audio:aac', 'video:h264'])
  assert.ok(Math.abs(got.duration - 4) < 0.3, JSON.stringify(got))
  // Every picture decodes: wrong AES output would corrupt the transport stream.
  sh('ffmpeg', ['-v', 'error', '-xerror', '-i', path.join(r.out, done.path.slice(5)), '-f', 'null', '-'])
  return { file: done.path, size: done.size, ...got }
})

await check('memory: a module over its memory cap fails alone, and the next run works', async () => {
  const capped = await ubit(['get', base + '/big/index.m3u8', '--no-library', '--json', '-o', '/out'], { allowAddress: onlyLoopback, maxMemory: 24 * 1024 * 1024 }).catch(err => ({ code: 'threw', error: String(err) }))
  assert.notEqual(capped.code, 0)
  // The same stream with the default cap succeeds, so the failure above is the cap and nothing else.
  const after = await ubit(['get', base + '/big/index.m3u8', '--no-library', '--json', '-o', '/out'], { allowAddress: onlyLoopback })
  assert.equal(after.code, 0, JSON.stringify(after.events.at(-1)))
  return { capped: capped.code, cappedError: capped.error || capped.events?.at(-1), uncapped: after.events.find(e => e.event === 'done') }
})

server.close()
fs.rmSync(tmp, { recursive: true, force: true })
const ok = results.every(r => r.ok)
fs.writeFileSync(path.join(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), 'e2e-result.json'), JSON.stringify({ ok, date: new Date().toISOString(), results }, null, 2) + '\n')
console.log(ok ? 'all passed' : 'FAILED')
Bare.exitCode = ok ? 0 : 1
