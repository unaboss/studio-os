// Runs code the agent wrote (bank statement parsers) where it can do no harm.
//
// The container this runs in has no network, a read-only root, a non-root
// user and tight memory, CPU and process limits. On top of that, each job runs
// in its own Node process with the permission model on: it may read only its
// own job file, and may not write files, start processes or use workers.
//
// Jobs arrive as files because the container has no network at all:
//   in/<id>.json   {"code": "...function body...", "input": "..."}
//   out/<id>.json  {"ok": true, "result": ...} or {"ok": false, "error": "..."}

import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = process.env.JOBS_DIR ?? '/jobs'
const TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 5000)
const MAX_OUTPUT = 4 * 1024 * 1024
const RUN_ONE = fileURLToPath(new URL('./run-one.mjs', import.meta.url))

export async function runJob(workFile)
{
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [
            '--permission',
            `--allow-fs-read=${workFile}`,
            `--allow-fs-read=${RUN_ONE}`,
            '--max-old-space-size=96',
            RUN_ONE,
            workFile,
        ], { stdio: ['ignore', 'pipe', 'pipe'], env: {} })
        let out = ''
        let err = ''
        let killed = false
        const timer = setTimeout(() => {
            killed = true
            child.kill('SIGKILL')
        }, TIMEOUT_MS)
        child.stdout.on('data', (d) => {
            out += d
            if (out.length > MAX_OUTPUT) {
                killed = true
                child.kill('SIGKILL')
            }
        })
        child.stderr.on('data', (d) => { err += d })
        child.on('close', () => {
            clearTimeout(timer)
            if (killed) return resolve({ ok: false, error: `Stopped: took longer than ${TIMEOUT_MS} ms or printed too much` })
            try {
                resolve(JSON.parse(out))
            } catch {
                resolve({ ok: false, error: (err || 'The parser crashed').slice(0, 500) })
            }
        })
    })
}

async function tick()
{
    const inbox = join(DIR, 'in')
    for (const name of await readdir(inbox)) {
        if (!/^[\w-]+\.json$/.test(name)) continue
        const work = join(DIR, 'work', name)
        try {
            await rename(join(inbox, name), work)
        } catch {
            continue
        }
        const result = await runJob(work)
        await writeFile(join(DIR, 'out', `${name}.tmp`), JSON.stringify(result))
        await rename(join(DIR, 'out', `${name}.tmp`), join(DIR, 'out', name))
        await unlink(work).catch(() => {})
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    for (const d of ['in', 'work', 'out']) await mkdir(join(DIR, d), { recursive: true })
    console.log(`sandbox: watching ${DIR}`)
    for (;;) {
        await tick().catch((e) => console.error('sandbox:', e))
        await new Promise((r) => setTimeout(r, 300))
    }
}
