import { createHmac, timingSafeEqual } from 'node:crypto'
import { extname } from 'node:path'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import
{
    AGENT,
    ConfigError,
    createContext,
    DEFAULT_CONFIG,
    ForbiddenError,
    formatMoney as money,
    newId,
    NotFoundError,
    slug,
    ValidationError,
    type Actor,
    type CompanyConfig,
    type Ctx,
    type Db,
    type Side,
} from '@studio-os/core'
import { checkParsedLines, explainChange, formatSignature, runMorning, writeBankParser, type Explanation, type Inference } from '@studio-os/agent'
import { GITHUB, handleGithubEvent, type GithubService } from '@studio-os/module-github'
import { importBankLines, parseBankCsv, withFingerprints } from '@studio-os/module-money'
import { hashPassword, readSession, sessionToken, verifyGithubSignature, verifyPassword } from './auth.ts'
import { CodeError, REPO_NAME, type CodeRepos } from './codetree.ts'
import { codePeople, projectHealth } from './codeinsights.ts'
import type { Sandbox } from './sandbox.ts'
import { mailService } from './services.ts'
import { Companies, INSTALLED } from './studio.ts'

export interface AppOptions
{
    readonly db: Db
    readonly sessionSecret: string
    readonly secureCookies?: boolean
    readonly github?: GithubService | null
    readonly githubWebhookSecret?: string | undefined
    readonly inference?: Inference | null
    readonly sandbox?: Sandbox | null
    readonly mail?: { resendKey?: string | undefined; from?: string | undefined }
    /** Shows the demo logins on the sign-in page. */
    readonly demo?: boolean
    /** Repos kept on the server for the code tree. */
    readonly code?: CodeRepos | null
    readonly now?: () => Date
}

interface UserRow
{
    id: string
    company_id: string
    email: string
    name: string
    role: 'manager' | 'employee'
    password_hash: string | null
    github_login: string | null
    active: boolean
}

type Env = { Variables: { user: UserRow; ctx: Ctx } }

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function createApp(opts: AppOptions): Hono<Env>
{
    const { db } = opts
    const companies = new Companies(db)
    const mail = mailService(opts.mail ?? {})
    const now = opts.now ?? (() => new Date())
    const app = new Hono<Env>()
    const attempts = new Map<string, { n: number; until: number }>()

    async function contextFor(companyId: string, actor: Actor): Promise<Ctx>
    {
        const registry = await companies.registry(companyId)
        const services: Record<string, unknown> = {}
        const ctx = createContext({ db, companyId, actor, registry, services, now })
        services.mail = mail.bind(ctx)
        if (opts.github) services.github = opts.github
        return ctx
    }

    const actorOf = (u: UserRow): Actor => ({ id: u.id, kind: 'user', role: u.role, name: u.name })

    app.onError((err, c) => {
        if (err instanceof ValidationError) return c.json({ error: err.message, problems: err.problems }, 400)
        if (err instanceof CodeError) return c.json({ error: err.message, problems: [err.message] }, 400)
        if (err instanceof ConfigError) return c.json({ error: err.message }, 400)
        if (err instanceof ForbiddenError) return c.json({ error: err.message }, 403)
        if (err instanceof NotFoundError) return c.json({ error: err.message }, 404)
        console.error(err)
        return c.json({ error: err instanceof Error ? err.message : 'Something went wrong' }, 500)
    })

    app.get('/api/health', (c) => c.json({ ok: true }))

    /* ---------------- GitHub webhook (signed, no session) ---------------- */

    app.post('/api/github/webhook', async (c) => {
        const raw = await c.req.text()
        if (!opts.githubWebhookSecret) return c.json({ error: 'Webhook secret not set on the server' }, 503)
        if (!verifyGithubSignature(opts.githubWebhookSecret, raw, c.req.header('x-hub-signature-256'))) return c.json({ error: 'Bad signature' }, 401)
        const event = c.req.header('x-github-event') ?? ''
        if (event === 'ping') return c.json({ ok: true, pong: true })
        const companyId = c.req.query('company') ?? (await companies.first())
        if (!companyId) return c.json({ error: 'No company' }, 404)
        const ctx = await contextFor(companyId, GITHUB)
        const result = await handleGithubEvent(ctx, event, JSON.parse(raw))
        return c.json({ ok: true, result })
    })

    /* ---------------- Sign in ---------------- */

    app.get('/api/login-info', (c) => c.json({
        demo: !!opts.demo,
        signup: true,
        accounts: opts.demo
            ? [
                { label: 'Manager', email: 'thabo@demo.studio', password: 'demo-manager' },
                { label: 'Developer', email: 'lerato@demo.studio', password: 'demo-employee' },
            ]
            : [],
    }))

    app.post('/api/login', async (c) => {
        const { email, password } = await c.req.json<{ email?: string; password?: string }>()
        const key = `${c.req.header('x-forwarded-for') ?? 'local'}|${String(email).toLowerCase()}`
        const a = attempts.get(key)
        if (a && a.n >= 5 && a.until > Date.now()) return c.json({ error: 'Too many tries. Wait 15 minutes.' }, 429)
        const rows = await db.query<UserRow>('select * from users where lower(email) = lower($1) and active', [String(email ?? '')])
        const user = rows[0]
        if (!user || !(await verifyPassword(String(password ?? ''), user.password_hash))) {
            attempts.set(key, { n: (a && a.until > Date.now() ? a.n : 0) + 1, until: Date.now() + 15 * 60_000 })
            return c.json({ error: 'That email and password do not match' }, 401)
        }
        attempts.delete(key)
        setCookie(c, 'sid', sessionToken(opts.sessionSecret, user.id), {
            httpOnly: true,
            sameSite: 'Lax',
            secure: opts.secureCookies ?? false,
            path: '/',
            maxAge: 14 * 86_400,
        })
        return c.json({ id: user.id, name: user.name, role: user.role })
    })

    // Anyone can start their own space, solo or as a team, and plant their repos in it.
    app.post('/api/signup', async (c) => {
        const b = await c.req.json<{ company?: string; name?: string; email?: string; password?: string }>()
        const ip = c.req.header('x-forwarded-for') ?? 'local'
        const a = attempts.get(`signup|${ip}`)
        if (a && a.n >= 5 && a.until > Date.now()) return c.json({ error: 'Too many new accounts from here. Try again in an hour.' }, 429)
        const email = String(b.email ?? '').trim().toLowerCase()
        const name = String(b.name ?? '').trim()
        const company = String(b.company ?? '').trim() || `${name}'s code`
        const problems: string[] = []
        if (!name) problems.push('Your name is needed')
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push('That email does not look right')
        if (String(b.password ?? '').length < 10) problems.push('Use a password of 10 or more characters')
        if (problems.length) throw new ValidationError(problems)
        if ((await db.query('select 1 from users where lower(email) = $1', [email])).length) throw new ValidationError(['That email already has an account. Sign in instead.'])
        attempts.set(`signup|${ip}`, { n: (a && a.until > Date.now() ? a.n : 0) + 1, until: Date.now() + 60 * 60_000 })
        const companyId = newId('co')
        const config = { ...DEFAULT_CONFIG, modules: ['projects', 'github'], theme: { ...DEFAULT_CONFIG.theme, name: company } }
        await db.query('insert into companies (id, name, config) values ($1, $2, $3::jsonb)', [companyId, company, JSON.stringify(config)])
        const userId = newId('usr')
        await db.query(
            'insert into users (id, company_id, email, name, role, password_hash) values ($1, $2, $3, $4, $5, $6)',
            [userId, companyId, email, name, 'manager', await hashPassword(String(b.password))],
        )
        setCookie(c, 'sid', sessionToken(opts.sessionSecret, userId), { httpOnly: true, sameSite: 'Lax', secure: opts.secureCookies ?? false, path: '/', maxAge: 14 * 86_400 })
        return c.json({ id: userId, name, role: 'manager' })
    })

    app.post('/api/logout', (c) => {
        deleteCookie(c, 'sid', { path: '/' })
        return c.json({ ok: true })
    })

    /* ---------------- Everything else needs a session ---------------- */

    /* ---------------- Previews: a repo's website as it was at any commit ---------------- */

    // A preview link carries its own signed, expiring token, so the page and its files load
    // without the session cookie. Pages run sandboxed in an opaque origin, even when opened
    // in a tab of their own, so a site's scripts can never reach the app or its API.
    const previewSign = (v: string) => createHmac('sha256', `preview:${opts.sessionSecret}`).update(v).digest('base64url')
    app.get('/preview/:token', (c) => c.redirect(`${c.req.path}/`))
    app.get('/preview/:token/*', async (c) => {
        if (!opts.code) return c.text('Previews are off on this server.', 404)
        const [payload = '', mac = ''] = c.req.param('token').split('.')
        const good = Buffer.from(previewSign(payload))
        if (!payload || good.length !== Buffer.from(mac).length || !timingSafeEqual(good, Buffer.from(mac))) return c.text('This preview link is not valid.', 403)
        const t = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { r: string; s: string; d: string; e: number }
        if (t.e < Date.now()) return c.text('This preview link has expired. Press View again.', 410)
        let path = decodeURIComponent(c.req.path.split('/').slice(3).join('/'))
        if (!path || path.endsWith('/')) path += 'index.html'
        let body: Buffer | null = null
        for (const p of extname(path) ? [path] : [path, `${path}.html`, `${path}/index.html`]) {
            body = await opts.code.raw(t.r, t.s, t.d + p).catch(() => null)
            if (body) { path = p; break }
        }
        if (!body) return c.text(`${path} is not in this commit.`, 404)
        return c.body(new Uint8Array(body), 200, {
            'content-type': PREVIEW_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
            'content-security-policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            'cache-control': 'private, max-age=3600',
        })
    })

    app.use('/api/*', async (c, next) => {
        if (MUTATING.has(c.req.method) && !(c.req.header('content-type') ?? '').includes('application/json')) {
            return c.json({ error: 'Send JSON' }, 415)
        }
        const userId = readSession(opts.sessionSecret, getCookie(c, 'sid'))
        if (!userId) return c.json({ error: 'Please sign in' }, 401)
        const rows = await db.query<UserRow>('select * from users where id = $1 and active', [userId])
        const user = rows[0]
        if (!user) return c.json({ error: 'Please sign in' }, 401)
        c.set('user', user)
        c.set('ctx', await contextFor(user.company_id, actorOf(user)))
        await next()
    })

    const managerOnly = (c: Context<Env>) => {
        if (c.get('user').role !== 'manager') throw new ForbiddenError('Managers only')
    }

    app.get('/api/me', async (c) => {
        const u = c.get('user')
        const ctx = c.get('ctx')
        const company = await db.query<{ name: string }>('select name from companies where id = $1', [u.company_id])
        return c.json({
            id: u.id,
            name: u.name,
            email: u.email,
            role: u.role,
            githubLogin: u.github_login,
            company: company[0]?.name ?? '',
            theme: ctx.config.theme,
            currency: ctx.config.currency,
        })
    })

    app.patch('/api/me', async (c) => {
        const u = c.get('user')
        const body = await c.req.json<{ password?: string; currentPassword?: string; githubLogin?: string }>()
        if (body.password !== undefined) {
            if (!(await verifyPassword(String(body.currentPassword ?? ''), u.password_hash))) throw new ValidationError(['Your current password is wrong'])
            if (body.password.length < 10) throw new ValidationError(['Use at least 10 characters'])
            await db.query('update users set password_hash = $1 where id = $2', [await hashPassword(body.password), u.id])
        }
        if (body.githubLogin !== undefined) await db.query('update users set github_login = $1 where id = $2', [body.githubLogin.trim() || null, u.id])
        return c.json({ ok: true })
    })

    /** What the screens are built from: record types, actions, tiles, layout. */
    app.get('/api/schema', (c) => {
        const ctx = c.get('ctx')
        const isManager = c.get('user').role === 'manager'
        const r = ctx.registry
        return c.json({
            modules: r.modules.map((m) => ({ id: m.id, name: m.name })),
            recordTypes: r.recordTypes()
                .filter((t) => isManager || t.visibility !== 'managers')
                .map((t) => ({ ...t, fields: t.fields.filter((f) => isManager || !f.sensitive) })),
            actions: r.actions()
                .filter((a) => isManager || !a.managersOnly)
                .map(({ name, label, description, params, needsApproval, managersOnly }) => ({ name, label, description, params, needsApproval, managersOnly: !!managersOnly })),
            tiles: {
                manage: isManager ? r.tiles('manage').map(({ id, title, size }) => ({ id, title, size: size ?? 'md' })) : [],
                employee: r.tiles('employee').map(({ id, title, size }) => ({ id, title, size: size ?? 'md' })),
            },
            projectTypes: ctx.config.projectTypes.map(({ id, name, billing }) => ({ id, name, billing })),
        })
    })

    app.get('/api/today', async (c) => {
        const side = (c.req.query('side') ?? 'employee') as Side
        if (side === 'manage') managerOnly(c)
        const ctx = c.get('ctx')
        const tiles = await Promise.all(ctx.registry.tiles(side).map(async (t) => {
            try {
                return { id: t.id, title: t.title, size: t.size ?? 'md', data: await t.load(ctx) }
            } catch (err) {
                return { id: t.id, title: t.title, size: t.size ?? 'md', error: err instanceof Error ? err.message : String(err) }
            }
        }))
        return c.json({ tiles })
    })

    /* ---------------- Records ---------------- */

    app.get('/api/records/:type', async (c) => {
        const ctx = c.get('ctx')
        const q = c.req.query()
        const where: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(q)) {
            if (!k.startsWith('w.')) continue
            where[k.slice(2)] = v === 'me' ? ctx.actor.id : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v
        }
        const records = await ctx.records.list(c.req.param('type'), {
            ...(q.parentId ? { parentId: q.parentId } : {}),
            ...(q.status ? { status: q.status.split(',') } : {}),
            where,
            limit: q.limit ? Number(q.limit) : 500,
        })
        return c.json({ records })
    })

    app.get('/api/record/:id', async (c) => {
        const ctx = c.get('ctx')
        const record = await ctx.records.get(c.req.param('id'))
        const children: Record<string, unknown[]> = {}
        for (const t of ctx.registry.recordTypes().filter((t) => t.parent === record.type)) {
            try {
                children[t.type] = await ctx.records.list(t.type, { parentId: record.id })
            } catch {
                // Types this person cannot see are left out.
            }
        }
        const events = await db.query(
            `select name, actor_id, actor_kind, payload, created_at from events where company_id = $1 and record_id = $2 order by id desc limit 40`,
            [ctx.companyId, record.id],
        )
        const parent = record.parentId ? await ctx.records.get(record.parentId).catch(() => null) : null
        return c.json({ record, parent, children, events: c.get('user').role === 'manager' ? events : [] })
    })

    app.post('/api/records/:type', async (c) => {
        const ctx = c.get('ctx')
        const body = await c.req.json<{ title: string; status?: string; parentId?: string; data?: Record<string, unknown> }>()
        const record = await ctx.records.create({
            type: c.req.param('type'),
            title: String(body.title ?? ''),
            ...(body.status ? { status: body.status } : {}),
            ...(body.parentId ? { parentId: body.parentId } : {}),
            data: fillSelf(ctx, c.req.param('type'), body.data ?? {}),
        })
        return c.json({ record }, 201)
    })

    app.patch('/api/record/:id', async (c) => {
        const ctx = c.get('ctx')
        const body = await c.req.json<{ title?: string; status?: string; data?: Record<string, unknown> }>()
        const record = await ctx.records.update(c.req.param('id'), {
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
            ...(body.data !== undefined ? { data: body.data } : {}),
        })
        return c.json({ record })
    })

    /* ---------------- Actions and approvals ---------------- */

    app.post('/api/actions/:name', async (c) => {
        const ctx = c.get('ctx')
        const params = await c.req.json<Record<string, unknown>>()
        const outcome = await ctx.actions.request(c.req.param('name'), params, { via: 'ui' })
        return c.json(outcome)
    })

    app.get('/api/approvals', async (c) => {
        managerOnly(c)
        const ctx = c.get('ctx')
        const status = c.req.query('status') ?? 'pending'
        const rows = await db.query(
            `select a.*, u.name as requested_by_name from approvals a left join users u on u.id = a.requested_by
             where a.company_id = $1 and a.status = $2 order by a.created_at desc limit 100`,
            [ctx.companyId, status],
        )
        // Say which invoice or claim each approval is about, not just its id.
        const approvals = []
        for (const row of rows as { params: Record<string, unknown> | string }[]) {
            const params = typeof row.params === 'string' ? JSON.parse(row.params) : row.params
            const refs: Record<string, { id: string; title: string; type: string }> = {}
            for (const [k, v] of Object.entries(params ?? {})) {
                if (!k.endsWith('Id') || typeof v !== 'string') continue
                const rec = await ctx.records.getRaw(v).catch(() => null)
                if (rec) refs[k] = { id: rec.id, title: rec.type === 'invoice' ? `${rec.title} · ${money(Number(rec.data.amount) - Number(rec.data.paid ?? 0))} due ${rec.data.due ?? ''}` : rec.title, type: rec.type }
            }
            approvals.push({ ...row, params, refs })
        }
        return c.json({ approvals })
    })

    app.post('/api/approvals/:id', async (c) => {
        const ctx = c.get('ctx')
        const { approve, params } = await c.req.json<{ approve: boolean; params?: Record<string, unknown> }>()
        if (approve && params) {
            // A manager may edit a draft (say, the reminder text) before approving it.
            await db.query(`update approvals set params = params || $1::jsonb where id = $2 and company_id = $3 and status = 'pending'`, [JSON.stringify(params), c.req.param('id'), ctx.companyId])
        }
        return c.json({ approval: await ctx.actions.decide(c.req.param('id'), !!approve) })
    })

    /* ---------------- Activity ---------------- */

    app.get('/api/activity', async (c) => {
        const ctx = c.get('ctx')
        const isManager = c.get('user').role === 'manager'
        const name = c.req.query('name')
        const params: unknown[] = [ctx.companyId]
        const where = ['e.company_id = $1']
        if (!isManager) {
            params.push(ctx.actor.id)
            where.push(`e.actor_id = $${params.length}`)
        }
        if (name) {
            params.push(name)
            where.push(`e.name = $${params.length}`)
        }
        const rows = await db.query(
            `select e.id, e.name, e.record_id, e.actor_id, e.actor_kind, e.payload, e.created_at, u.name as actor_name
             from events e left join users u on u.id = e.actor_id
             where ${where.join(' and ')} and e.name not like '%.updated' order by e.id desc limit ${Math.min(Number(c.req.query('limit') ?? 60), 200)}`,
            params,
        )
        return c.json({ events: rows })
    })

    /* ---------------- People and settings (managers) ---------------- */

    app.get('/api/users', async (c) => {
        const ctx = c.get('ctx')
        const isManager = c.get('user').role === 'manager'
        const rows = await db.query<UserRow>('select * from users where company_id = $1 order by name', [ctx.companyId])
        return c.json({
            users: rows.filter((u) => isManager || u.active).map((u) => ({
                id: u.id,
                name: u.name,
                role: u.role,
                githubLogin: u.github_login,
                ...(isManager ? { email: u.email, active: u.active } : {}),
            })),
        })
    })

    app.post('/api/users', async (c) => {
        managerOnly(c)
        const ctx = c.get('ctx')
        const b = await c.req.json<{ name: string; email: string; role: 'manager' | 'employee'; password: string; githubLogin?: string }>()
        const problems: string[] = []
        if (!b.name?.trim()) problems.push('Name is required')
        if (!/^\S+@\S+\.\S+$/.test(b.email ?? '')) problems.push('A valid email is required')
        if (!['manager', 'employee'].includes(b.role)) problems.push('Role must be manager or employee')
        if (!b.password || b.password.length < 10) problems.push('Give them a first password of at least 10 characters')
        if (problems.length) throw new ValidationError(problems)
        const id = newId('usr')
        await db.query(
            `insert into users (id, company_id, email, name, role, password_hash, github_login) values ($1, $2, $3, $4, $5, $6, $7)`,
            [id, ctx.companyId, b.email.trim().toLowerCase(), b.name.trim(), b.role, await hashPassword(b.password), b.githubLogin?.trim() || null],
        )
        return c.json({ id }, 201)
    })

    app.patch('/api/users/:id', async (c) => {
        managerOnly(c)
        const ctx = c.get('ctx')
        const b = await c.req.json<{ role?: string; active?: boolean; githubLogin?: string; name?: string }>()
        const id = c.req.param('id')
        if (id === c.get('user').id && (b.active === false || b.role === 'employee')) throw new ValidationError(['You cannot demote or switch off yourself'])
        if (b.role !== undefined && !['manager', 'employee'].includes(b.role)) throw new ValidationError(['Role must be manager or employee'])
        await db.query(
            `update users set role = coalesce($1, role), active = coalesce($2, active), github_login = coalesce($3, github_login), name = coalesce($4, name)
             where id = $5 and company_id = $6`,
            [b.role ?? null, b.active ?? null, b.githubLogin ?? null, b.name ?? null, id, ctx.companyId],
        )
        return c.json({ ok: true })
    })

    app.get('/api/settings', async (c) => {
        managerOnly(c)
        const ctx = c.get('ctx')
        const company = await db.query<{ name: string }>('select name from companies where id = $1', [ctx.companyId])
        return c.json({
            name: company[0]?.name ?? '',
            config: ctx.config,
            installed: INSTALLED.map((m) => ({
                id: m.id,
                name: m.name,
                description: m.description,
                required: !!m.required,
                dependsOn: m.dependsOn ?? [],
                records: m.records.map((r) => ({ type: r.type, label: r.label, statuses: r.statuses, fields: r.fields.map((f) => f.key) })),
                tiles: (m.tiles ?? []).map((t) => ({ id: t.id, title: t.title, sides: t.sides })),
            })),
            integrations: {
                github: !!opts.github,
                githubWebhook: !!opts.githubWebhookSecret,
                inference: opts.inference ? opts.inference.model : null,
                sandbox: !!opts.sandbox,
                mail: !!opts.mail?.resendKey,
            },
        })
    })

    app.put('/api/settings', async (c) => {
        managerOnly(c)
        const ctx = c.get('ctx')
        const { config, name } = await c.req.json<{ config: CompanyConfig; name?: string }>()
        await companies.save(ctx.companyId, config)
        if (name?.trim()) await db.query('update companies set name = $1 where id = $2', [name.trim(), ctx.companyId])
        await ctx.events.emit('settings.changed', { payload: {} })
        return c.json({ ok: true })
    })

    /* ---------------- Automations ---------------- */

    app.get('/api/automations', async (c) => {
        managerOnly(c)
        const ctx = c.get('ctx')
        const rules = await db.query('select * from automations where company_id = $1 order by created_at', [ctx.companyId])
        const events = new Set<string>()
        for (const m of ctx.registry.modules) for (const e of m.emits) events.add(e)
        for (const t of ctx.registry.recordTypes()) {
            for (const e of ['created', 'updated', 'status_changed']) events.add(`${t.type}.${e}`)
            for (const s of t.statuses) events.add(`${t.type}.${slug(s)}`)
        }
        return c.json({
            rules,
            events: [...events].sort(),
            actions: ctx.registry.actions().map(({ name, label, params, needsApproval }) => ({ name, label, params, needsApproval })),
        })
    })

    const ruleBody = async (c: Context<Env>) => {
        const b = await c.req.json<{ name: string; enabled?: boolean; when: string; conditions?: unknown[]; action: string; params?: Record<string, unknown> }>()
        const ctx = c.get('ctx')
        const problems: string[] = []
        if (!b.name?.trim()) problems.push('Give the rule a name')
        if (!b.when) problems.push('Pick the event that starts it')
        if (!ctx.registry.actions().some((a) => a.name === b.action)) problems.push(`Unknown action "${b.action}"`)
        if (b.conditions && !Array.isArray(b.conditions)) problems.push('Conditions must be a list')
        if (problems.length) throw new ValidationError(problems)
        return b
    }

    app.post('/api/automations', async (c) => {
        managerOnly(c)
        const b = await ruleBody(c)
        const id = newId('auto')
        await db.query(
            `insert into automations (id, company_id, name, enabled, when_event, conditions, action, params) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)`,
            [id, c.get('ctx').companyId, b.name.trim(), b.enabled ?? true, b.when, JSON.stringify(b.conditions ?? []), b.action, JSON.stringify(b.params ?? {})],
        )
        return c.json({ id }, 201)
    })

    app.put('/api/automations/:id', async (c) => {
        managerOnly(c)
        const b = await ruleBody(c)
        await db.query(
            `update automations set name = $1, enabled = $2, when_event = $3, conditions = $4::jsonb, action = $5, params = $6::jsonb where id = $7 and company_id = $8`,
            [b.name.trim(), b.enabled ?? true, b.when, JSON.stringify(b.conditions ?? []), b.action, JSON.stringify(b.params ?? {}), c.req.param('id'), c.get('ctx').companyId],
        )
        return c.json({ ok: true })
    })

    app.delete('/api/automations/:id', async (c) => {
        managerOnly(c)
        await db.query('delete from automations where id = $1 and company_id = $2', [c.req.param('id'), c.get('ctx').companyId])
        return c.json({ ok: true })
    })

    /* ---------------- The agent ---------------- */

    app.post('/api/agent/run', async (c) => {
        managerOnly(c)
        const ctx = await contextFor(c.get('user').company_id, AGENT)
        const result = await runMorning(ctx, opts.inference ?? null)
        return c.json({ brief: result.brief, model: result.model, proposals: result.proposals })
    })

    app.get('/api/agent/brief', async (c) => {
        managerOnly(c)
        const rows = await db.query<{ payload: unknown; created_at: string }>(
            `select payload, created_at from events where company_id = $1 and name = 'agent.brief' order by id desc limit 1`,
            [c.get('ctx').companyId],
        )
        return c.json({ brief: rows[0] ?? null, model: opts.inference?.model ?? null })
    })

    /**
     * A statement format Studio OS does not know: the agent writes a parser,
     * it runs in the sandbox, and the manager sees a preview before anything
     * is imported. The parser is kept for the next statement in that format.
     */
    app.post('/api/bank/read', async (c) => {
        managerOnly(c)
        const ctx = c.get('ctx')
        const { csv } = await c.req.json<{ csv: string }>()
        try {
            const lines = parseBankCsv(String(csv))
            return c.json({ known: true, count: lines.length, preview: lines.slice(0, 8) })
        } catch (err) {
            if (!(err instanceof ValidationError)) throw err
        }
        const signature = formatSignature(String(csv))
        let parser = (await db.query<{ id: string; code: string; notes: string }>('select id, code, notes from bank_parsers where company_id = $1 and signature = $2 order by created_at desc limit 1', [ctx.companyId, signature]))[0]
        if (!parser) {
            if (!opts.inference) throw new ValidationError(['Studio OS does not know this statement format, and no model is connected to learn it'])
            if (!opts.sandbox) throw new ValidationError(['The sandbox is not running, so a new format cannot be learnt safely'])
            const written = await writeBankParser(opts.inference, String(csv))
            parser = { id: newId('prs'), code: written.code, notes: written.notes }
            const lines = checkParsedLines(await opts.sandbox.run(parser.code, String(csv)))
            await db.query('insert into bank_parsers (id, company_id, signature, code, notes) values ($1, $2, $3, $4, $5)', [parser.id, ctx.companyId, signature, parser.code, parser.notes])
            return c.json({ known: false, learnt: true, parserId: parser.id, notes: parser.notes, code: parser.code, count: lines.length, preview: lines.slice(0, 8) })
        }
        if (!opts.sandbox) throw new ValidationError(['The sandbox is not running'])
        const lines = checkParsedLines(await opts.sandbox.run(parser.code, String(csv)))
        return c.json({ known: false, learnt: false, parserId: parser.id, notes: parser.notes, code: parser.code, count: lines.length, preview: lines.slice(0, 8) })
    })

    app.post('/api/bank/import', async (c) => {
        managerOnly(c)
        const ctx = c.get('ctx')
        const { csv, account, parserId } = await c.req.json<{ csv: string; account?: string; parserId?: string }>()
        const name = account?.trim() || 'Main account'
        if (!parserId) return c.json(await importBankLines(ctx, parseBankCsv(String(csv)), name))
        const parser = (await db.query<{ code: string }>('select code from bank_parsers where id = $1 and company_id = $2', [parserId, ctx.companyId]))[0]
        if (!parser) throw new NotFoundError('Parser not found')
        if (!opts.sandbox) throw new ValidationError(['The sandbox is not running'])
        const lines = withFingerprints(checkParsedLines(await opts.sandbox.run(parser.code, String(csv))))
        return c.json(await importBankLines(ctx, lines, name))
    })

    // ---- Code tree: each project's repo as a tree of branches and commits ----

    /** Repos linked to projects this person can see. Nobody can point the server at other repos. */
    const projectRepos = async (ctx: Ctx) =>
    {
        const projects = await ctx.records.list('project', { limit: 500 })
        const clients = new Map((await ctx.records.list('client', { limit: 1000 }).catch(() => [])).map((c) => [c.id, c.title]))
        return projects
            .filter((p) => typeof p.data.repo === 'string' && REPO_NAME.test(String(p.data.repo).trim()))
            .map((p) => ({ projectId: p.id, project: p.title, status: p.status, repo: String(p.data.repo).trim(), clientId: String(p.data.client ?? ''), client: clients.get(String(p.data.client)) ?? '' }))
    }
    const allowedRepo = async (c: Context<Env>) =>
    {
        if (!opts.code) throw new ValidationError(['The code tree is not set up on this server'])
        const repo = String(c.req.query('repo') ?? '')
        if (!(await projectRepos(c.get('ctx'))).some((r) => r.repo === repo)) throw new ForbiddenError('Link this repo to a project first')
        return { code: opts.code, repo }
    }

    app.get('/api/code', async (c) => {
        const repos = await projectRepos(c.get('ctx'))
        const health = await projectHealth(c.get('ctx'), db, opts.code ?? null, repos, now())
        // Busiest first, so the tree opens on the project with the most going on.
        const rows = repos.map((r) => ({ ...r, ...health.get(r.projectId) }))
            .sort((a, b) => (b.lastCommit ?? '').localeCompare(a.lastCommit ?? ''))
        return c.json({ enabled: !!opts.code, repos: rows })
    })

    // Plant a repo: any GitHub repo this server can read grows its own tree.
    app.post('/api/code/plant', async (c) => {
        managerOnly(c)
        const ctx = c.get('ctx')
        if (!opts.code) throw new ValidationError(['The code tree is not set up on this server'])
        const raw = String((await c.req.json<{ repo?: string }>()).repo ?? '').trim()
        const repo = raw.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
        if (!REPO_NAME.test(repo)) throw new ValidationError(['Write the repo as owner/name, or paste its GitHub link'])
        const repos = await projectRepos(ctx)
        if (repos.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) return c.json({ repo: repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase())!.repo })
        if (repos.length >= 25) throw new ValidationError(['This space already has 25 trees. Remove one first.'])
        const graph = await opts.code.graph(repo)
        const [owner, name] = repo.split('/') as [string, string]
        const clients = await ctx.records.list('client', { limit: 1000 })
        const client = clients.find((r) => r.title.toLowerCase() === owner.toLowerCase())
            ?? await ctx.records.create({ type: 'client', title: owner, status: 'Active', data: {} })
        // Everyone in the space can see a planted tree, so a team shares it from the start.
        const members = (await db.query<{ id: string }>('select id from users where company_id = $1 and active', [ctx.companyId])).map((u) => u.id)
        await ctx.records.create({ type: 'project', title: name, status: 'Active', parentId: client.id, data: { client: client.id, projectType: 'build', repo, lead: ctx.actor.id, members, start: graph.commits.at(-1)?.date.slice(0, 10) } })
        return c.json({ repo })
    })

    // Where a commit's website starts, if it has one: the first folder with an index.html.
    app.get('/api/code/preview', async (c) => {
        const { code, repo } = await allowedRepo(c)
        const sha = String(c.req.query('sha') ?? '')
        const files = await code.files(repo, sha)
        const root = SITE_ROOTS.find((r) => files.includes(`${r}index.html`))
        if (root === undefined) return c.json({ url: null, root: '', reason: 'This commit has no index.html yet, so there is no site to show.' })
        const payload = Buffer.from(JSON.stringify({ r: repo, s: sha, d: root, e: Date.now() + 6 * 3_600_000 })).toString('base64url')
        return c.json({ url: `/preview/${payload}.${previewSign(payload)}/`, root })
    })

    app.get('/api/code/people', async (c) => {
        const ctx = c.get('ctx')
        return c.json(await codePeople(ctx, db, opts.code ?? null, await projectRepos(ctx), now()))
    })

    app.get('/api/code/graph', async (c) => {
        const { code, repo } = await allowedRepo(c)
        return c.json(await code.graph(repo))
    })

    app.get('/api/code/commit', async (c) => {
        const { code, repo } = await allowedRepo(c)
        return c.json(await code.commit(repo, String(c.req.query('sha') ?? '')))
    })

    app.get('/api/code/files', async (c) => {
        const { code, repo } = await allowedRepo(c)
        return c.json({ files: await code.files(repo, String(c.req.query('sha') ?? '')) })
    })

    const explained = new Map<string, Explanation>()
    app.post('/api/code/explain', async (c) => {
        const { code, repo } = await allowedRepo(c)
        const b = await c.req.json<{ sha?: string; base?: string; branch?: string }>()
        const sha = String(b.sha ?? '')
        const key = `${repo}:${b.base ?? ''}:${sha}`
        const cached = explained.get(key)
        if (cached) return c.json(cached)
        let result: Explanation
        if (b.base) {
            const r = await code.range(repo, String(b.base), sha)
            result = await explainChange(opts.inference ?? null, { repo, kind: 'branch', title: String(b.branch ?? 'this branch'), commits: r.commits, files: r.files, patch: r.patch })
        } else {
            const d = await code.commit(repo, sha)
            result = await explainChange(opts.inference ?? null, { repo, kind: 'commit', title: d.commit.subject, commits: [d.commit], files: d.files, patch: d.patch })
        }
        if (explained.size > 500) explained.clear()
        explained.set(key, result)
        return c.json(result)
    })

    app.get('/api/code/file', async (c) => {
        const { code, repo } = await allowedRepo(c)
        return c.json(await code.file(repo, String(c.req.query('sha') ?? ''), String(c.req.query('path') ?? '')))
    })

    return app
}

/** "me" in a user field means the person asking, so a form can say "claimed by me". */
function fillSelf(ctx: Ctx, type: string, data: Record<string, unknown>): Record<string, unknown>
{
    const rt = ctx.registry.recordType(type)
    const out = { ...data }
    for (const f of rt.fields) {
        if (f.kind === 'user' && out[f.key] === 'me') out[f.key] = ctx.actor.id
    }
    // An employee's claims, leave and time are always their own.
    if (ctx.actor.kind === 'user' && ctx.actor.role !== 'manager' && rt.assigneeField) {
        const field = rt.fields.find((f) => f.key === rt.assigneeField)
        if (field?.kind === 'user') out[rt.assigneeField] = ctx.actor.id
    }
    return out
}

const SITE_ROOTS = ['', 'public/', 'site/', 'docs/', 'www/', 'dist/', 'build/', 'src/']
const PREVIEW_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.xml': 'application/xml',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
}
