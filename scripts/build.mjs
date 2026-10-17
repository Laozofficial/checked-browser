// Builds the browser SDK:
//   dist/index.mjs + dist/*.d.ts      ESM core (no rrweb)
//   dist/replay.mjs                   ESM replay recorder (@checked/browser/replay, rrweb bundled)
//   dist/checked.min.js               IIFE core (window.Checked), 10 KB gzip budget
//   dist/checked-replay.min.js        IIFE replay recorder (window.CheckedReplay), loaded lazily
//   dist/checked-player.min.js        rrweb player for the Check’d app's replay viewer (not published)
// and copies the script builds into the frontend's public folder. Versioned (pinned) files are
// never overwritten with different content: change the version instead.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

export const BUDGETS = { core: 10 * 1024, replay: 70 * 1024 }

const versionSrc = readFileSync(join(root, 'src', 'version.ts'), 'utf8')
const m = versionSrc.match(/SDK_VERSION = '([^']+)'/)
if (!m || m[1] !== pkg.version) {
  console.error(`src/version.ts (${m ? m[1] : 'missing'}) does not match package.json (${pkg.version})`)
  process.exit(1)
}

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const common = {
  bundle: true,
  target: 'es2018',
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'warning',
}

const esm = (entry, out, banner) => build({ ...common, entryPoints: [join(root, 'src', entry)], format: 'esm', outfile: join(dist, out), sourcemap: true, ...(banner ? { banner } : {}) })
const rrwebVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'rrweb', 'package.json'), 'utf8')).version
// Bundles that carry rrweb keep its MIT notice.
const RRWEB_BANNER = { js: `/*! Includes rrweb ${rrwebVersion}, MIT License, https://github.com/rrweb-io/rrweb */` }
const iife = (entry, out, banner) => build({ ...common, entryPoints: [join(root, 'src', entry)], format: 'iife', outfile: join(dist, out), minify: true, sourcemap: false, ...(banner ? { banner } : {}) })

await esm('index.ts', 'index.mjs')
await esm('replay/index.ts', 'replay.mjs', RRWEB_BANNER)
await iife('iife.ts', 'checked.min.js')
await iife('replay-iife.ts', 'checked-replay.min.js', RRWEB_BANNER)
await iife('player/index.ts', 'checked-player.min.js', RRWEB_BANNER)

// Type declarations.
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' })

const gz = (file) => gzipSync(readFileSync(file), { level: 9 }).length
const report = (file) => `${(statSync(file).size / 1024).toFixed(2)} KB raw, ${(gz(file) / 1024).toFixed(2)} KB gzip`
for (const f of ['checked.min.js', 'checked-replay.min.js', 'checked-player.min.js', 'index.mjs', 'replay.mjs']) console.log(`dist/${f.padEnd(24)} ${report(join(dist, f))}`)

// Budgets are checked before anything is copied, so an oversized build never lands in the frontend.
const core = gz(join(dist, 'checked.min.js'))
const rep = gz(join(dist, 'checked-replay.min.js'))
if (core > BUDGETS.core) console.error(`Core IIFE gzip size ${core} bytes is over the ${BUDGETS.core / 1024} KB budget`)
if (rep > BUDGETS.replay) console.error(`Replay IIFE gzip size ${rep} bytes is over the ${BUDGETS.replay / 1024} KB budget`)
if (core > BUDGETS.core || rep > BUDGETS.replay) process.exit(1)

const norm = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n')
let failed = false
/** Copies a build; a pinned (versioned) target that exists must already have the same content. */
function publish(from, dir, name, pinned) {
  mkdirSync(dir, { recursive: true })
  const to = join(dir, name)
  if (pinned && existsSync(to)) {
    if (norm(readFileSync(to)) === norm(readFileSync(from))) return `${name} (unchanged)`
    console.error(`Refusing to overwrite pinned ${name}: its content differs. Bump the version in package.json and src/version.ts.`)
    failed = true
    return `${name} (REFUSED)`
  }
  copyFileSync(from, to)
  return name
}

const publicSdk = resolve(root, '..', '..', 'frontend', 'public', 'sdk')
const publicReplay = resolve(root, '..', '..', 'frontend', 'public', 'replay')
const major = pkg.version.split('.')[0]
const copied = [
  publish(join(dist, 'checked.min.js'), publicSdk, `checked.v${major}.min.js`, false),
  publish(join(dist, 'checked.min.js'), publicSdk, `checked.v${pkg.version}.min.js`, true),
  publish(join(dist, 'checked-replay.min.js'), publicSdk, `checked-replay.v${major}.min.js`, false),
  publish(join(dist, 'checked-replay.min.js'), publicSdk, `checked-replay.v${pkg.version}.min.js`, true),
]
// The app's player: same rrweb as the recorder. Follows this package's major version.
mkdirSync(publicReplay, { recursive: true })
copyFileSync(join(dist, 'checked-player.min.js'), join(publicReplay, `checked-player.v${major}.min.js`))
writeFileSync(join(publicReplay, `checked-player.v${major}.css`), readFileSync(join(root, 'node_modules', 'rrweb', 'dist', 'style.min.css')))

console.log(`copied to ${publicSdk}: ${copied.join(', ')}`)
console.log(`player copied to ${publicReplay}`)

if (failed) process.exit(1)
