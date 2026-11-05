// The `ubit_net` imports: the module asks for a host and port, and the host does DNS, TCP and TLS.
// Only public addresses are reachable unless `allowAddress` says otherwise; TLS verifies the certificate.
import tcp from 'bare-tcp'
import tls from 'bare-tls'
import dns from 'bare-dns'

const MAX_CONNECTIONS = 64
const CONNECT_TIMEOUT = 25_000
const IDLE_TIMEOUT = 30_000
const HIGH_WATER = 4 * 1024 * 1024

function parse4 (ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null
    n = n * 256 + Number(p)
  }
  return n
}

// Eight 16-bit groups, or null; accepts an embedded dotted IPv4 tail (::ffff:1.2.3.4).
function parse6 (ip) {
  let s = ip.replace(/^\[|\]$/g, '').split('%')[0]
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (tail) {
    const v4 = parse4(tail[1])
    if (v4 === null) return null
    s = s.slice(0, -tail[1].length) + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const groups = [...head, ...Array(fill).fill('0'), ...rest]
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return null
  return groups.map(g => parseInt(g, 16))
}

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([base, bits]) => [parse4(base), bits])

function public4 (n) {
  return !BLOCKED_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)))
}

// True for a globally routable unicast address. Mapped, NAT64 and 6to4 IPv6 addresses are judged by the IPv4 inside.
export function isPublicAddress (ip) {
  const v4 = parse4(ip)
  if (v4 !== null) return public4(v4)
  const g = parse6(ip)
  if (!g) return false
  const v4in = (hi, lo) => hi * 65536 + lo
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return public4(v4in(g[6], g[7])) // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return public4(v4in(g[6], g[7])) // NAT64
  if (g[0] === 0x2002) return public4(v4in(g[1], g[2])) // 6to4
  if (g.slice(0, 6).every(x => x === 0)) return false // ::, ::1 and IPv4-compatible
  if ((g[0] & 0xfe00) === 0xfc00) return false // unique local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return false // link and site local
  if ((g[0] & 0xff00) === 0xff00) return false // multicast
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] < 0x0200)) return false // documentation, Teredo and IETF blocks
  if (g[0] === 0x0100 && g.slice(1, 4).every(x => x === 0)) return false // discard
  return true
}

function lookupAll (host) {
  if (parse4(host) !== null || parse6(host)) return Promise.resolve([host.replace(/^\[|\]$/g, '')])
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true }, (err, addresses) => {
      if (err) reject(err)
      else resolve(addresses.map(a => a.address))
    })
  })
}

function connected (socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('connect timeout')) }, CONNECT_TIMEOUT)
    socket.once(event, () => { clearTimeout(timer); socket.off('error', fail); resolve() })
    const fail = (err) => { clearTimeout(timer); reject(err) }
    socket.once('error', fail)
  })
}

class Connection {
  constructor (socket) {
    this.socket = socket
    this.chunks = []
    this.buffered = 0
    this.ended = false
    this.error = null
    this.waiter = null
    socket.on('data', (data) => {
      this.chunks.push(data)
      this.buffered += data.byteLength
      if (this.buffered > HIGH_WATER) socket.pause()
      this.wake()
    })
    socket.on('end', () => { this.ended = true; this.wake() })
    socket.on('close', () => { this.ended = true; this.wake() })
    socket.on('error', (err) => { this.error = err; this.wake() })
  }

  wake () {
    const w = this.waiter
    this.waiter = null
    if (w) w()
  }

  async read (cap) {
    while (this.chunks.length === 0) {
      if (this.error) throw this.error
      if (this.ended) return null
      const idle = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(true), IDLE_TIMEOUT)
        this.waiter = () => { clearTimeout(timer); resolve(false) }
      })
      if (idle) throw new Error('read timeout')
    }
    let chunk = this.chunks[0]
    if (chunk.byteLength > cap) {
      this.chunks[0] = chunk.subarray(cap)
      chunk = chunk.subarray(0, cap)
    } else {
      this.chunks.shift()
    }
    this.buffered -= chunk.byteLength
    if (this.buffered <= HIGH_WATER / 2) this.socket.resume()
    return chunk
  }

  write (data) {
    return new Promise((resolve, reject) => {
      if (this.error || this.ended) return reject(this.error || new Error('closed'))
      if (this.socket.write(data)) resolve()
      else this.socket.once('drain', resolve)
    })
  }

  close () {
    this.socket.destroy()
  }
}

// `memory()` returns the module's current memory; `onrefuse(host, addresses)` reports a blocked connection.
export function createNet ({ memory, allowAddress = isPublicAddress, onrefuse = () => {} }) {
  const conns = new Map()
  let next = 1
  const bytes = (ptr, len) => new Uint8Array(memory().buffer, ptr, len)

  async function open (hostPtr, hostLen, port, useTls) {
    try {
      if (conns.size >= MAX_CONNECTIONS || port < 1 || port > 65535) return -1
      const name = bytes(hostPtr, hostLen)
      // Hostnames arrive punycoded; anything outside printable ASCII is refused rather than guessed at.
      if (hostLen <= 0 || hostLen > 255 || name.some(c => c < 0x21 || c > 0x7e)) return -1
      const host = String.fromCharCode(...name)
      if (/[/\\@]/.test(host)) return -1
      const addresses = await lookupAll(host)
      // Every address must pass, so a name with one private record cannot be steered to it.
      if (addresses.length === 0 || !addresses.every(a => allowAddress(a))) {
        onrefuse(host, addresses)
        return -1
      }
      const raw = tcp.createConnection(port, addresses[0])
      await connected(raw, 'connect')
      let socket = raw
      if (useTls) {
        socket = new tls.Socket(raw, { host: host.replace(/^\[|\]$/g, '') })
        await connected(socket, 'connect')
      }
      const handle = next++
      conns.set(handle, new Connection(socket))
      return handle
    } catch {
      return -1
    }
  }

  async function read (handle, ptr, cap) {
    const conn = conns.get(handle)
    if (!conn || cap <= 0) return -1
    try {
      const chunk = await conn.read(cap)
      if (chunk === null) return 0
      bytes(ptr, chunk.byteLength).set(chunk)
      return chunk.byteLength
    } catch {
      return -1
    }
  }

  async function write (handle, ptr, len) {
    const conn = conns.get(handle)
    if (!conn || len < 0) return -1
    try {
      await conn.write(bytes(ptr, len).slice())
      return len
    } catch {
      return -1
    }
  }

  function close (handle) {
    const conn = conns.get(handle)
    if (!conn) return
    conns.delete(handle)
    conn.close()
  }

  return {
    imports: {
      open: new WebAssembly.Suspending(open),
      read: new WebAssembly.Suspending(read),
      write: new WebAssembly.Suspending(write),
      close
    },
    destroy () {
      for (const conn of conns.values()) conn.close()
      conns.clear()
    }
  }
}
