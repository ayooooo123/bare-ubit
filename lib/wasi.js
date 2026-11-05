// The part of WASI preview 1 that ubit.wasm imports, over bare-fs. Files are reachable only inside the
// preopened directories: absolute paths, `..` above a preopen, and symlinks that lead out are refused.
import fs from 'bare-fs'
import path from 'bare-path'

const E = {
  SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, LOOP: 32, NAMETOOLONG: 37,
  NOENT: 44, NOSPC: 51, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, SPIPE: 70, PERM: 63, XDEV: 75, NOTCAPABLE: 76
}
const FILETYPE = { UNKNOWN: 0, CHARACTER_DEVICE: 2, DIRECTORY: 3, REGULAR_FILE: 4, SYMBOLIC_LINK: 7 }
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 }
const FDFLAG_APPEND = 1
const RIGHT_FD_READ = 1n << 1n
const RIGHT_FD_WRITE = 1n << 6n
const ALL_RIGHTS = 0xffffffffffffffffn

export class ProcExit extends Error {
  constructor (code) {
    super('exit ' + code)
    this.code = code
  }
}

function errno (err) {
  if (err instanceof ProcExit) throw err
  return E[String(err?.code || '').replace(/^E/, '')] ?? E.IO
}

function filetype (st) {
  if (st.isDirectory()) return FILETYPE.DIRECTORY
  if (st.isFile()) return FILETYPE.REGULAR_FILE
  if (st.isSymbolicLink()) return FILETYPE.SYMBOLIC_LINK
  return FILETYPE.UNKNOWN
}

// `preopens` maps guest paths ('/out') to host directories; `stdout`/`stderr` receive the module's writes.
export function createWasi ({ memory, args, env = {}, preopens = {}, stdout, stderr }) {
  const fds = new Map([[0, { kind: 'stdio' }], [1, { kind: 'stdio', sink: stdout }], [2, { kind: 'stdio', sink: stderr }]])
  let nextFd = 3
  for (const [guest, host] of Object.entries(preopens)) {
    fs.mkdirSync(host, { recursive: true })
    fds.set(nextFd++, { kind: 'dir', root: fs.realpathSync(host), segs: [], name: Buffer.from(guest) })
  }

  const view = () => new DataView(memory().buffer)
  const bytes = (ptr, len) => new Uint8Array(memory().buffer, ptr, len)
  const str = (ptr, len) => Buffer.from(bytes(ptr, len)).toString()
  const argv = args.map(a => Buffer.from(a + '\0'))
  const envv = Object.entries(env).map(([k, v]) => Buffer.from(k + '=' + v + '\0'))

  function iovecs (ptr, len) {
    const dv = view()
    const out = []
    for (let i = 0; i < len; i++) out.push(bytes(dv.getUint32(ptr + i * 8, true), dv.getUint32(ptr + i * 8 + 4, true)))
    return out
  }

  // Joins `rel` onto a directory fd, refusing anything that would land outside its preopen.
  function resolve (dirfd, rel) {
    const dir = fds.get(dirfd)
    if (!dir || dir.kind !== 'dir') return { error: E.BADF }
    if (rel.startsWith('/') || rel.includes('\0')) return { error: E.NOTCAPABLE }
    const segs = [...dir.segs]
    for (const s of rel.split('/')) {
      if (s === '' || s === '.') continue
      if (s === '..') {
        if (segs.length === 0) return { error: E.NOTCAPABLE }
        segs.pop()
      } else {
        segs.push(s)
      }
    }
    const host = path.join(dir.root, ...segs)
    // The deepest part that exists must resolve inside the root, so no symlink can lead out.
    for (let probe = host; ; probe = path.dirname(probe)) {
      let real = null
      try { real = fs.realpathSync(probe) } catch {}
      if (real !== null) {
        if (real !== dir.root && !real.startsWith(dir.root + path.sep)) return { error: E.NOTCAPABLE }
        break
      }
      if (probe === dir.root || path.dirname(probe) === probe) break
    }
    return { host, root: dir.root, segs }
  }

  function file (fd) {
    const f = fds.get(fd)
    return f && f.kind === 'file' ? f : null
  }

  function writeVecs (f, vecs, at) {
    let total = 0
    for (const v of vecs) {
      if (v.byteLength === 0) continue
      const pos = at !== undefined ? at + total : (f.append ? fs.fstatSync(f.hostFd).size : f.pos)
      const n = fs.writeSync(f.hostFd, v, 0, v.byteLength, pos)
      total += n
      if (at === undefined) f.pos = pos + n
      if (n < v.byteLength) break
    }
    return total
  }

  const wasi = {
    args_sizes_get (countPtr, sizePtr) {
      const dv = view()
      dv.setUint32(countPtr, argv.length, true)
      dv.setUint32(sizePtr, argv.reduce((n, b) => n + b.byteLength, 0), true)
      return E.SUCCESS
    },
    args_get (argvPtr, bufPtr) {
      const dv = view()
      for (let i = 0; i < argv.length; i++) {
        dv.setUint32(argvPtr + i * 4, bufPtr, true)
        bytes(bufPtr, argv[i].byteLength).set(argv[i])
        bufPtr += argv[i].byteLength
      }
      return E.SUCCESS
    },
    environ_sizes_get (countPtr, sizePtr) {
      const dv = view()
      dv.setUint32(countPtr, envv.length, true)
      dv.setUint32(sizePtr, envv.reduce((n, b) => n + b.byteLength, 0), true)
      return E.SUCCESS
    },
    environ_get (envPtr, bufPtr) {
      const dv = view()
      for (let i = 0; i < envv.length; i++) {
        dv.setUint32(envPtr + i * 4, bufPtr, true)
        bytes(bufPtr, envv[i].byteLength).set(envv[i])
        bufPtr += envv[i].byteLength
      }
      return E.SUCCESS
    },
    // shortcut: every clock reads the wall clock (Bare has no monotonic clock without another module); a clock step skews durations.
    clock_time_get (id, precision, timePtr) {
      view().setBigUint64(timePtr, BigInt(Date.now()) * 1000000n, true)
      return E.SUCCESS
    },
    fd_close (fd) {
      const f = fds.get(fd)
      if (!f || fd < 3) return E.BADF
      fds.delete(fd)
      if (f.kind === 'file') fs.closeSync(f.hostFd)
      return E.SUCCESS
    },
    fd_fdstat_get (fd, ptr) {
      const f = fds.get(fd)
      if (!f) return E.BADF
      const dv = view()
      // Standard streams report as seekable character devices, which wasi-libc's isatty() reads as "not a terminal".
      dv.setUint8(ptr, f.kind === 'dir' ? FILETYPE.DIRECTORY : f.kind === 'file' ? FILETYPE.REGULAR_FILE : FILETYPE.CHARACTER_DEVICE)
      dv.setUint16(ptr + 2, f.append ? FDFLAG_APPEND : 0, true)
      dv.setBigUint64(ptr + 8, ALL_RIGHTS, true)
      dv.setBigUint64(ptr + 16, ALL_RIGHTS, true)
      return E.SUCCESS
    },
    fd_fdstat_set_flags (fd, flags) {
      const f = file(fd)
      if (!f) return E.BADF
      f.append = (flags & FDFLAG_APPEND) !== 0
      return E.SUCCESS
    },
    fd_filestat_set_size (fd, size) {
      const f = file(fd)
      if (!f) return E.BADF
      try { fs.ftruncateSync(f.hostFd, Number(size)) } catch (err) { return errno(err) }
      return E.SUCCESS
    },
    fd_prestat_get (fd, ptr) {
      const f = fds.get(fd)
      if (!f || !f.name) return E.BADF
      const dv = view()
      dv.setUint8(ptr, 0)
      dv.setUint32(ptr + 4, f.name.byteLength, true)
      return E.SUCCESS
    },
    fd_prestat_dir_name (fd, ptr, len) {
      const f = fds.get(fd)
      if (!f || !f.name) return E.BADF
      bytes(ptr, Math.min(len, f.name.byteLength)).set(f.name.subarray(0, len))
      return E.SUCCESS
    },
    fd_read (fd, iovs, iovsLen, nreadPtr) {
      const f = fds.get(fd)
      if (!f || f.kind === 'dir') return E.BADF
      let total = 0
      if (f.kind === 'file') {
        try {
          for (const v of iovecs(iovs, iovsLen)) {
            const n = fs.readSync(f.hostFd, v, 0, v.byteLength, f.pos)
            f.pos += n
            total += n
            if (n < v.byteLength) break
          }
        } catch (err) { return errno(err) }
      }
      view().setUint32(nreadPtr, total, true)
      return E.SUCCESS
    },
    fd_write (fd, iovs, iovsLen, nwrittenPtr) {
      const f = fds.get(fd)
      if (!f || f.kind === 'dir') return E.BADF
      const vecs = iovecs(iovs, iovsLen)
      let total = 0
      if (f.kind === 'stdio') {
        for (const v of vecs) { if (f.sink) f.sink(v.slice()); total += v.byteLength }
      } else {
        try { total = writeVecs(f, vecs) } catch (err) { return errno(err) }
      }
      view().setUint32(nwrittenPtr, total, true)
      return E.SUCCESS
    },
    fd_pwrite (fd, iovs, iovsLen, offset, nwrittenPtr) {
      const f = file(fd)
      if (!f) return E.BADF
      let total
      try { total = writeVecs(f, iovecs(iovs, iovsLen), Number(offset)) } catch (err) { return errno(err) }
      view().setUint32(nwrittenPtr, total, true)
      return E.SUCCESS
    },
    fd_seek (fd, offset, whence, newPtr) {
      const f = file(fd)
      if (!f) return fds.has(fd) ? E.SPIPE : E.BADF
      let base
      try { base = whence === 0 ? 0 : whence === 1 ? f.pos : fs.fstatSync(f.hostFd).size } catch (err) { return errno(err) }
      const pos = base + Number(offset)
      if (pos < 0 || whence > 2) return E.INVAL
      f.pos = pos
      view().setBigUint64(newPtr, BigInt(pos), true)
      return E.SUCCESS
    },
    fd_sync (fd) {
      const f = file(fd)
      if (!f) return E.BADF
      try { fs.fsyncSync(f.hostFd) } catch (err) { return errno(err) }
      return E.SUCCESS
    },
    fd_readdir (fd, buf, bufLen, cookie, usedPtr) {
      const d = fds.get(fd)
      if (!d || d.kind !== 'dir') return E.BADF
      let entries
      try { entries = fs.readdirSync(path.join(d.root, ...d.segs), { withFileTypes: true }) } catch (err) { return errno(err) }
      let used = 0
      for (let i = Number(cookie); i < entries.length && used < bufLen; i++) {
        const name = Buffer.from(entries[i].name)
        const rec = new Uint8Array(24 + name.byteLength)
        const dv = new DataView(rec.buffer)
        dv.setBigUint64(0, BigInt(i + 1), true)
        dv.setUint32(16, name.byteLength, true)
        dv.setUint8(20, entries[i].isDirectory() ? FILETYPE.DIRECTORY : entries[i].isFile() ? FILETYPE.REGULAR_FILE : FILETYPE.UNKNOWN)
        rec.set(name, 24)
        // A record cut short at the end tells wasi-libc to call again with a larger buffer.
        const n = Math.min(rec.byteLength, bufLen - used)
        bytes(buf + used, n).set(rec.subarray(0, n))
        used += n
      }
      view().setUint32(usedPtr, used, true)
      return E.SUCCESS
    },
    path_open (dirfd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInheriting, fdflags, fdPtr) {
      const r = resolve(dirfd, str(pathPtr, pathLen))
      if (r.error) return r.error
      let st = null
      try { st = fs.statSync(r.host) } catch {}
      if (st && (oflags & OFLAGS.EXCL) && (oflags & OFLAGS.CREAT)) return E.EXIST
      if (st && st.isDirectory()) {
        if (rightsBase & RIGHT_FD_WRITE && !(oflags & OFLAGS.DIRECTORY)) return E.ISDIR
        fds.set(nextFd, { kind: 'dir', root: r.root, segs: r.segs })
        view().setUint32(fdPtr, nextFd++, true)
        return E.SUCCESS
      }
      if (oflags & OFLAGS.DIRECTORY) return st ? E.NOTDIR : E.NOENT
      if (!st && !(oflags & OFLAGS.CREAT)) return E.NOENT
      const read = (rightsBase & RIGHT_FD_READ) !== 0n
      const write = (rightsBase & RIGHT_FD_WRITE) !== 0n || (oflags & OFLAGS.TRUNC) !== 0
      const c = fs.constants
      let flags = write ? (read ? c.O_RDWR : c.O_WRONLY) : c.O_RDONLY
      if (oflags & OFLAGS.CREAT) flags |= c.O_CREAT
      if (oflags & OFLAGS.TRUNC) flags |= c.O_TRUNC
      let hostFd
      try { hostFd = fs.openSync(r.host, flags, 0o644) } catch (err) { return errno(err) }
      fds.set(nextFd, { kind: 'file', hostFd, pos: 0, append: (fdflags & FDFLAG_APPEND) !== 0 })
      view().setUint32(fdPtr, nextFd++, true)
      return E.SUCCESS
    },
    path_filestat_get (dirfd, flags, pathPtr, pathLen, buf) {
      const r = resolve(dirfd, str(pathPtr, pathLen))
      if (r.error) return r.error
      let st
      try { st = (flags & 1) ? fs.statSync(r.host) : fs.lstatSync(r.host) } catch (err) { return errno(err) }
      const dv = view()
      const ns = (ms) => BigInt(Math.max(0, Math.floor((ms || 0) * 1e6)))
      dv.setBigUint64(buf, 0n, true)
      dv.setBigUint64(buf + 8, BigInt(st.ino || 0), true)
      dv.setUint8(buf + 16, filetype(st))
      dv.setBigUint64(buf + 24, BigInt(st.nlink || 1), true)
      dv.setBigUint64(buf + 32, BigInt(st.size || 0), true)
      dv.setBigUint64(buf + 40, ns(st.atimeMs), true)
      dv.setBigUint64(buf + 48, ns(st.mtimeMs), true)
      dv.setBigUint64(buf + 56, ns(st.ctimeMs), true)
      return E.SUCCESS
    },
    path_create_directory (dirfd, pathPtr, pathLen) {
      const r = resolve(dirfd, str(pathPtr, pathLen))
      if (r.error) return r.error
      try { fs.mkdirSync(r.host) } catch (err) { return errno(err) }
      return E.SUCCESS
    },
    path_remove_directory (dirfd, pathPtr, pathLen) {
      const r = resolve(dirfd, str(pathPtr, pathLen))
      if (r.error) return r.error
      if (r.segs.length === 0) return E.NOTCAPABLE
      try { fs.rmdirSync(r.host) } catch (err) { return errno(err) }
      return E.SUCCESS
    },
    path_unlink_file (dirfd, pathPtr, pathLen) {
      const r = resolve(dirfd, str(pathPtr, pathLen))
      if (r.error) return r.error
      try {
        if (fs.lstatSync(r.host).isDirectory()) return E.ISDIR
        fs.unlinkSync(r.host)
      } catch (err) { return errno(err) }
      return E.SUCCESS
    },
    path_rename (fromFd, fromPtr, fromLen, toFd, toPtr, toLen) {
      const from = resolve(fromFd, str(fromPtr, fromLen))
      if (from.error) return from.error
      const to = resolve(toFd, str(toPtr, toLen))
      if (to.error) return to.error
      if (from.segs.length === 0 || to.segs.length === 0) return E.NOTCAPABLE
      try { fs.renameSync(from.host, to.host) } catch (err) { return errno(err) }
      return E.SUCCESS
    },
    // The module cannot make symlinks and none may lead out, so nothing it can name is a link worth reading.
    path_readlink () {
      return E.INVAL
    },
    // Only clock subscriptions are waited on; anything else reports ready at once.
    poll_oneoff: new WebAssembly.Suspending(async (inPtr, outPtr, nsubs, neventsPtr) => {
      let dv = view()
      let wait = Infinity
      for (let i = 0; i < nsubs; i++) {
        const s = inPtr + i * 48
        if (dv.getUint8(s + 8) !== 0) { wait = 0; continue }
        let ns = Number(dv.getBigUint64(s + 24, true))
        if (dv.getUint16(s + 40, true) & 1) ns -= Date.now() * 1e6
        wait = Math.min(wait, Math.max(0, ns))
      }
      if (wait > 0 && wait !== Infinity) await new Promise(resolve => setTimeout(resolve, Math.ceil(wait / 1e6)))
      dv = view()
      for (let i = 0; i < nsubs; i++) {
        const s = inPtr + i * 48
        const e = outPtr + i * 32
        dv.setBigUint64(e, dv.getBigUint64(s, true), true)
        dv.setUint16(e + 8, 0, true)
        dv.setUint8(e + 10, dv.getUint8(s + 8))
      }
      dv.setUint32(neventsPtr, nsubs, true)
      return E.SUCCESS
    }),
    proc_exit (code) {
      throw new ProcExit(code)
    }
  }

  return {
    imports: wasi,
    destroy () {
      for (const f of fds.values()) if (f.kind === 'file') try { fs.closeSync(f.hostFd) } catch {}
      fds.clear()
    }
  }
}
