import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import postgres from 'postgres'
import { pgliteDb, postgresJsDb, type Db } from '@studio-os/core'
import { listModels, vultrInference, type Inference } from '@studio-os/agent'
import { createApp } from './app.ts'
import { codeRepos, type CodeRepos } from './codetree.ts'
import { folderSandbox } from './sandbox.ts'
import { startScheduler } from './scheduler.ts'
import { githubService } from './services.ts'
import { Companies, migrateAll } from './studio.ts'

const env = process.env

export async function connect(): Promise<{ db: Db; close: () => Promise<void> }>
{
    const url = env.DATABASE_URL
    if (!url) throw new Error('Set DATABASE_URL, e.g. postgres://studio:secret@localhost:5432/studio')
    if (url.startsWith('pglite:')) {
        // Postgres in-process, for trying Studio OS without a database server.
        const { PGlite } = await import('@electric-sql/pglite')
        const path = url.slice('pglite:'.length)
        const pg = path ? new PGlite(path) : new PGlite()
        const db = pgliteDb(pg)
        await migrateAll(db)
        return { db, close: () => pg.close() }
    }
    const sql = postgres(url, { max: 10, onnotice: () => {} })
    const db = postgresJsDb(sql as never)
    await migrateAll(db)
    return { db, close: () => sql.end() }
}

/** Picks a chat model when none is named: the first that looks like a general instruct model. */
async function chooseModel(apiKey: string): Promise<string | null>
{
    try {
        const models = await listModels(apiKey)
        const preferred = models.find((m) => /qwen|deepseek|llama|glm|mistral/i.test(m) && !/embed|safety|guard|whisper|tts|image/i.test(m))
        return preferred ?? models[0] ?? null
    } catch (err) {
        console.error('inference: could not list models', err)
        return null
    }
}

export async function main(): Promise<void>
{
    const secret = env.SESSION_SECRET
    if (!secret || secret.length < 32) throw new Error('Set SESSION_SECRET to at least 32 random characters')
    const { db } = await connect()

    let inference: Inference | null = null
    if (env.VULTR_INFERENCE_API_KEY) {
        const model = env.VULTR_INFERENCE_MODEL || (await chooseModel(env.VULTR_INFERENCE_API_KEY))
        if (model) {
            inference = vultrInference({ apiKey: env.VULTR_INFERENCE_API_KEY, model })
            console.log(`inference: Vultr Serverless Inference, model ${model}`)
        }
    } else console.log('inference: off (no VULTR_INFERENCE_API_KEY); the agent writes plain briefs')

    const github = env.GITHUB_TOKEN ? githubService(env.GITHUB_TOKEN) : null
    const sandbox = env.SANDBOX_DIR ? folderSandbox(env.SANDBOX_DIR) : null

    if (env.SEED_DEMO === '1') {
        const { seedDemo } = await import('./seed.ts')
        await seedDemo(db)
    }

    // The code tree keeps each project's repo on this machine's disk.
    let code: CodeRepos | null = null
    const hasGit = await promisify(execFile)('git', ['--version']).then(() => true, () => false)
    if (hasGit) {
        const dir = env.CODE_DIR ?? join(tmpdir(), 'studio-os-code')
        let local: Record<string, string> = {}
        if (env.SEED_DEMO === '1') {
            const { makeDemoRepos } = await import('./demo-repos.ts')
            local = await makeDemoRepos(join(dir, 'demo')).catch((err) => {
                console.error('code tree: could not build the demo repos', err)
                return {}
            })
        }
        code = codeRepos({ dir, local, token: env.GITHUB_TOKEN })
        setInterval(() => void code?.refreshAll(), 5 * 60_000).unref()
        console.log(`code tree: repos kept in ${dir}, fetched every 5 minutes`)
    } else console.log('code tree: off (git is not installed)')

    const app = createApp({
        db,
        sessionSecret: secret,
        secureCookies: env.COOKIE_SECURE !== '0',
        github,
        githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
        inference,
        sandbox,
        mail: { resendKey: env.RESEND_API_KEY, from: env.MAIL_FROM },
        demo: env.DEMO === '1',
        code,
    })

    const web = resolve(env.WEB_DIST ?? join(import.meta.dirname, '../../web/dist'))
    app.use('/assets/*', serveStatic({ root: web }))
    app.use('/favicon.svg', serveStatic({ root: web }))
    const index = await readFile(join(web, 'index.html'), 'utf8').catch(() => '<!doctype html><p>Build the web app first: npm run build</p>')
    app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.html(index)))

    if (env.SCHEDULER !== '0') startScheduler({ db, companies: new Companies(db), inference, services: () => (github ? { github } : {}) })

    const port = Number(env.PORT ?? 3000)
    serve({ fetch: app.fetch, port, hostname: '0.0.0.0' })
    console.log(`Studio OS on :${port}`)
}

if (process.argv[1]?.endsWith('server.ts')) {
    main().catch((err) => {
        console.error(err)
        process.exit(1)
    })
}
