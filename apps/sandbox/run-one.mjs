// One job, in a process started with --permission (see runner.mjs).
import { readFileSync } from 'node:fs'

const write = (obj) => process.stdout.write(JSON.stringify(obj))

try {
    const job = JSON.parse(readFileSync(process.argv[2], 'utf8'))
    const fn = new Function('input', `"use strict";\n${job.code}`)
    const result = fn(job.input)
    write({ ok: true, result })
} catch (err) {
    write({ ok: false, error: String(err && err.message ? err.message : err).slice(0, 500) })
}
