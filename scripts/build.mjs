// Builds dist/index.mjs (ESM), dist/*.d.ts (types) and dist/checked.min.js (IIFE),
// then copies the IIFE into the frontend's public/sdk folder.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

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

await build({
  ...common,
  entryPoints: [join(root, 'src', 'index.ts')],
  format: 'esm',
  outfile: join(dist, 'index.mjs'),
  sourcemap: true,
})

await build({
  ...common,
  entryPoints: [join(root, 'src', 'iife.ts')],
  format: 'iife',
  outfile: join(dist, 'checked.min.js'),
  minify: true,
  sourcemap: false,
})

// Type declarations.
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' })

// Copy to the frontend.
const publicSdk = resolve(root, '..', '..', 'frontend', 'public', 'sdk')
mkdirSync(publicSdk, { recursive: true })
const iife = join(dist, 'checked.min.js')
const major = pkg.version.split('.')[0]
const targets = [`checked.v${major}.min.js`, `checked.v${pkg.version}.min.js`]
for (const t of targets) copyFileSync(iife, join(publicSdk, t))

const report = (file) => {
  const buf = readFileSync(file)
  return `${(statSync(file).size / 1024).toFixed(2)} KB raw, ${(gzipSync(buf, { level: 9 }).length / 1024).toFixed(2)} KB gzip`
}
console.log(`dist/checked.min.js  ${report(iife)}`)
console.log(`dist/index.mjs       ${report(join(dist, 'index.mjs'))}`)
console.log(`copied to ${publicSdk}: ${targets.join(', ')}`)
const gz = gzipSync(readFileSync(iife), { level: 9 }).length
if (gz > 10 * 1024) {
  console.error(`IIFE gzip size ${gz} bytes is over the 10 KB budget`)
  process.exit(1)
}
