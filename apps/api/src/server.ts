import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import postgres from 'postgres'
import { postgresJsDb, type Db } from '@studio-os/core'
import { listModels, vultrInference, type Inference } from '@studio-os/agent'
import { createApp } from './app.ts'
import { folderSandbox } from './sandbox.ts'
import { startScheduler } from './scheduler.ts'
import { githubService } from './services.ts'
import { Companies, migrateAll } from './studio.ts'

const env = process.env

export async function connect(): Promise<{ db: Db; close: () => Promise<void> }>
{
    const url = env.DATABASE_URL
    if (!url) throw new Error('Set DATABASE_URL, e.g. postgres://studio:secret@localhost:5432/studio')
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

async function main(): Promise<void>
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
