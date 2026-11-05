# bare-ubit

[uBit](https://github.com/ayooooo123/ubit), the web video downloader, compiled to WebAssembly and run in a sandbox under [Bare](https://github.com/holepunchto/bare).

uBit reads pages and streams from anywhere. Here its extractors, HLS/DASH parsers and MP4 muxer run inside `ubit.wasm`. The module can reach only what the host hands it:

- **Files:** its config folder (`/config`) and, if given, one output folder (`/out`). Absolute paths, `..` above either folder, and symlinks leading out are refused.
- **Network:** the module asks for a host and port. The host resolves the name and connects only if no address falls in a blocked range: loopback, private, link-local, CGNAT, multicast, benchmarking, documentation (`192.0.2.0/24` and siblings, `2001:db8::/32`, `3fff::/20`), unique-local, discard and dummy (`100::/63`), local-use NAT64 (`64:ff9b:1::/48`), SRv6 (`5f00::/16`) and the other special-purpose blocks that aren't globally reachable. IPv4-mapped, well-known NAT64 and 6to4 addresses are judged by the IPv4 address inside them. `lib/net.js` was checked against IANA's IPv4 and IPv6 special-purpose registries (last updated 2025-10-09). It's stricter in two places: all of `192.0.0.0/24` and `2001::/23` are refused, including the few globally reachable anycast blocks inside them. A range IANA adds later passes until it's added. The check runs on every connection, so a redirect to a private address is refused too. The host does TLS and verifies certificates against Mozilla's roots.
- **Environment:** none of the host's. The module sees `HOME=/config` and `UBIT_CONFIG_DIR=/config`.
- **Memory:** capped by the host (`maxMemory`, default 4 GiB, the wasm32 limit). A module over its cap fails on its own.

Needs Bare 1.36 or later: the module's blocking reads and sleeps suspend through JS Promise Integration, which Node 24 does not enable.

## CLI

```sh
bare-ubit [--config DIR] [--allow-private] <ubit arguments>
bare-ubit info --json 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
bare-ubit get --no-library --json -o ./downloads 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
```

Same commands, flags, NDJSON events and exit codes as `ubit`; paths in its output are host paths. The config folder defaults to `$UBIT_CONFIG_DIR`, else `~/.config/uBit`. Without `-o`, `get` saves to `~/Downloads`. No other host path is reachable, so flags that name a file elsewhere will not find it.

## API

```js
import { run } from 'bare-ubit'

const code = await run(['get', url, '--no-library', '--json', '-o', '/out'], {
  config: '/path/to/config', // seen as /config
  out: '/path/to/output', // seen as /out
  stdout: (bytes) => {}, // default: fd 1
  stderr: (bytes) => {}, // default: fd 2
  allowAddress: (ip) => isPublicAddress(ip),
  onrefuse: (host, addresses) => {},
  maxMemory: 4 * 1024 ** 3
})
```

To stop a run that will not finish, run the CLI as a child process and end it: code inside the module cannot be interrupted from its own thread.

## Limits of this build

- One connection at a time (the module has no threads): a full download took 57 s here against 24 s for native `ubit`.
- No ffmpeg, so `--to mp3/opus/mkv/webm` and WebM sources fail; MP4 and M4A mux natively.
- No proxy; a configured proxy makes requests fail rather than bypass it.
- uBit reads a file it muxes whole, so a single track over the memory cap fails.

## Build

`ubit.wasm` comes from uBit's `linux/build_wasm.sh` (wasi-sdk 34). Copy `dist/ubit.wasm` here.

## Test

```sh
npm test # needs ffmpeg and ffprobe; writes test/e2e-result.json
```

Address policy, the folder jail (including a symlink out), a refused private address and redirect, a direct MP4, AES-128 HLS decrypted and muxed, and a memory cap that fails only its own run.
