// Copy the built island bundle from web/dist into the repo's static/react so
// the classic Flask app serves it via asset_url('react/bookings.js'). Runs as
// the `build` poststep locally; the Docker build copies dist/ the same way.
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, '..', 'dist')
const dest = resolve(here, '..', '..', 'static', 'react')

await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })
await cp(dist, dest, { recursive: true })
console.log(`[copy-dist] ${dist} -> ${dest}`)
