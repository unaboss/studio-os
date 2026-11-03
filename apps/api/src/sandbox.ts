import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Sandbox
{
    run(code: string, input: string): Promise<unknown>
}

/**
 * Talks to the sandbox container through a shared folder, because that
 * container has no network at all (see apps/sandbox/runner.mjs).
 */
export function folderSandbox(dir: string, timeoutMs = 15_000): Sandbox
{
    return {
        async run(code, input) {
            const id = randomUUID()
            const tmp = join(dir, 'in', `${id}.tmp`)
            await writeFile(tmp, JSON.stringify({ code, input }))
            await rename(tmp, join(dir, 'in', `${id}.json`))
            const out = join(dir, 'out', `${id}.json`)
            const deadline = Date.now() + timeoutMs
            while (Date.now() < deadline) {
                try {
                    const result = JSON.parse(await readFile(out, 'utf8')) as { ok: boolean; result?: unknown; error?: string }
                    await unlink(out).catch(() => {})
                    if (!result.ok) throw new Error(`The parser failed in the sandbox: ${result.error}`)
                    return result.result
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
                }
                await new Promise((r) => setTimeout(r, 200))
            }
            throw new Error('The sandbox did not answer in time. Is the sandbox container running?')
        },
    }
}
