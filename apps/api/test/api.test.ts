import { createHmac } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { pgliteDb, type Db } from '@studio-os/core'
import type { Inference } from '@studio-os/agent'
import { createApp } from '../src/app.ts'
import { seedDemo } from '../src/seed.ts'
import { migrateAll } from '../src/studio.ts'

const SECRET = 'x'.repeat(40)
const HOOK_SECRET = 'hook-secret'

let db: Db
let app: ReturnType<typeof createApp>
const replies: string[] = []

const fakeModel: Inference = {
    model: 'fake-model',
    async chat(messages) {
        const next = replies.shift()
        if (next) return next
        return JSON.stringify({ brief: `Brief from the model. ${messages.length} messages.`, proposals: [] })
    },
}

beforeAll(async () => {
    db = pgliteDb(new PGlite())
    await migrateAll(db)
    await seedDemo(db, { now: new Date('2026-11-03T06:00:00Z') })
    app = createApp({
        db,
        sessionSecret: SECRET,
        githubWebhookSecret: HOOK_SECRET,
        inference: fakeModel,
        demo: true,
        // A stand-in for the container: the real one is tested in apps/sandbox.
        sandbox: { async run(code, input) { return new Function('input', code)(input) } },
        now: () => new Date('2026-11-03T06:00:00Z'),
    })
}, 60_000)

async function signIn(email: string, password: string): Promise<string>
{
    const res = await app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
    expect(res.status).toBe(200)
    return res.headers.get('set-cookie')!.split(';')[0]!
}

function client(cookie: string)
{
    const call = async (method: string, path: string, body?: unknown) => {
        const res = await app.request(path, {
            method,
            headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        return { status: res.status, body: (await res.json()) as any }
    }
    return {
        get: (p: string) => call('GET', p),
        post: (p: string, b: unknown = {}) => call('POST', p, b),
        patch: (p: string, b: unknown) => call('PATCH', p, b),
        put: (p: string, b: unknown) => call('PUT', p, b),
    }
}

describe('sign in', () => {
    it('refuses bad passwords and anonymous calls', async () => {
        const bad = await app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'thabo@demo.studio', password: 'nope' }) })
        expect(bad.status).toBe(401)
        expect((await app.request('/api/me')).status).toBe(401)
    })

    it('needs JSON for changes, which blocks cross-site form posts', async () => {
        const cookie = await signIn('thabo@demo.studio', 'demo-manager')
        const res = await app.request('/api/actions/bank.auto_match', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })
        expect(res.status).toBe(415)
    })
})

describe('the two sides', () => {
    it('gives the manager a full Today page', async () => {
        const m = client(await signIn('thabo@demo.studio', 'demo-manager'))
        const { body } = await m.get('/api/today?side=manage')
        const byId = Object.fromEntries(body.tiles.map((t: any) => [t.id, t]))
        expect(body.tiles.every((t: any) => !t.error)).toBe(true)
        expect(byId['money.cash'].data.value).toMatch(/^R/)
        expect(byId['money.owed'].data.caption).toContain('overdue')
        expect(byId['projects.health'].data.value).toBe('3')
        expect(byId['compliance.next']).toBeTruthy()
    })

    it('keeps the employee to their own side', async () => {
        const e = client(await signIn('lerato@demo.studio', 'demo-employee'))
        expect((await e.get('/api/today?side=manage')).status).toBe(403)
        const { body } = await e.get('/api/today?side=employee')
        const ids = body.tiles.map((t: any) => t.id)
        expect(ids[0]).toBe('projects.my_tasks')
        expect(body.tiles.find((t: any) => t.id === 'github.my_reviews').data.value).toBe('1')
        const schema = (await e.get('/api/schema')).body
        expect(schema.recordTypes.map((t: any) => t.type)).not.toContain('invoice')
        const project = schema.recordTypes.find((t: any) => t.type === 'project')
        expect(project.fields.map((f: any) => f.key)).not.toContain('value')
        expect((await e.get('/api/records/invoice')).body.records).toEqual([])
        expect((await e.get('/api/approvals')).status).toBe(403)
    })

    it('lets an employee claim an expense but not approve it', async () => {
        const e = client(await signIn('lerato@demo.studio', 'demo-employee'))
        const created = await e.post('/api/records/expense', { title: 'Parking', data: { amount: 4000, date: '2026-11-02', claimant: 'usr_demo_thabo' } })
        expect(created.status).toBe(201)
        expect(created.body.record.data.claimant).toBe('usr_demo_lerato')
        const approve = await e.patch(`/api/record/${created.body.record.id}`, { status: 'Approved' })
        expect(approve.status).toBe(403)
        const payslipTry = await e.post('/api/records/payslip', { title: 'x', data: { user: 'me', month: '2026-11', gross: 1 } })
        expect(payslipTry.status).toBe(403)
    })
})

describe('approvals', () => {
    it('shows the agent reminder from the morning run and sends it on approval', async () => {
        const m = client(await signIn('thabo@demo.studio', 'demo-manager'))
        const { body } = await m.get('/api/approvals')
        const reminder = body.approvals.find((a: any) => a.action === 'invoice.send_reminder')
        expect(reminder.requested_via).toBe('agent')
        const decided = await m.post(`/api/approvals/${reminder.id}`, { approve: true, params: { message: 'Hi Megan, a gentle nudge on INV-0002.' } })
        expect(decided.body.approval.status).toBe('approved')
        const outbox = await m.get('/api/activity?name=mail.outbox')
        expect(outbox.body.events[0].payload.text).toBe('Hi Megan, a gentle nudge on INV-0002.')
    })

    it('queues a phase invoice to send, through the demo automation', async () => {
        const m = client(await signIn('thabo@demo.studio', 'demo-manager'))
        const projects = (await m.get('/api/records/project')).body.records
        const booking = projects.find((p: any) => p.title === 'Booking website')
        const phases = (await m.get(`/api/records/phase?parentId=${booking.id}`)).body.records
        const first = phases.find((p: any) => p.data.order === 1)
        await m.post('/api/actions/phase.complete', { phaseId: first.id })
        const { body } = await m.get('/api/approvals')
        expect(body.approvals.some((a: any) => a.action === 'invoice.send' && a.requested_via === 'automation:auto_demo_send')).toBe(true)
    })
})

describe('agent', () => {
    it('uses the model brief and refuses actions it is not allowed', async () => {
        replies.push('Sure! ```json\n' + JSON.stringify({
            brief: 'Cash is fine. One invoice is late.',
            proposals: [{ action: 'payroll.draft_month', params: { month: '2026-11' }, why: 'payday' }],
        }) + '\n```')
        const m = client(await signIn('thabo@demo.studio', 'demo-manager'))
        const { body } = await m.post('/api/agent/run')
        expect(body.brief).toBe('Cash is fine. One invoice is late.')
        expect(body.model).toBe('fake-model')
        expect(body.proposals[0].outcome).toMatchObject({ status: 'refused' })
        const brief = await m.get('/api/agent/brief')
        expect(brief.body.brief.payload.text).toBe('Cash is fine. One invoice is late.')
    })

    it('learns an unknown statement format, previews it, then imports it', async () => {
        const csv = 'WEIRDBANK EXPORT v2\nwhen|what|rands\n03.11.2026|COFFEE BEANS|-250,00\n02.11.2026|CLIENT EFT|1500,00\n'
        replies.push(JSON.stringify({
            code: `return input.split('\\n').filter(l => /^\\d\\d\\./.test(l)).map(l => { const [d, what, r] = l.split('|'); const [dd, mm, yy] = d.split('.'); return { date: yy + '-' + mm + '-' + dd, amount: Math.round(Number(r.replace(',', '.')) * 100), balance: null, description: what, reference: null } })`,
            notes: 'Pipe separated, day.month.year dates',
        }))
        const m = client(await signIn('thabo@demo.studio', 'demo-manager'))
        const read = await m.post('/api/bank/read', { csv })
        expect(read.body).toMatchObject({ known: false, learnt: true, count: 2 })
        expect(read.body.preview[0]).toMatchObject({ date: '2026-11-03', amount: -25_000 })
        const imported = await m.post('/api/bank/import', { csv, account: 'Weirdbank', parserId: read.body.parserId })
        expect(imported.body).toEqual({ added: 2, skipped: 0 })
        const again = await m.post('/api/bank/read', { csv })
        expect(again.body.learnt).toBe(false)
    })
})

describe('settings', () => {
    it('adds a custom field and reorders the layout without code', async () => {
        const m = client(await signIn('thabo@demo.studio', 'demo-manager'))
        const { body } = await m.get('/api/settings')
        const config = body.config
        config.fields = { ...config.fields, client: [{ key: 'vatNumber', label: 'VAT number', kind: 'text' }] }
        config.layouts = { ...config.layouts, manage: ['projects.health', ...config.layouts.manage.filter((t: string) => t !== 'projects.health')] }
        expect((await m.put('/api/settings', { config })).status).toBe(200)
        const schema = (await m.get('/api/schema')).body
        expect(schema.recordTypes.find((t: any) => t.type === 'client').fields.map((f: any) => f.key)).toContain('vatNumber')
        expect(schema.tiles.manage[0].id).toBe('projects.health')
    })

    it('rejects a config that breaks the registry', async () => {
        const m = client(await signIn('thabo@demo.studio', 'demo-manager'))
        const { body } = await m.get('/api/settings')
        const bad = { ...body.config, fields: { client: [{ key: 'email', label: 'Clash', kind: 'text' }] } }
        expect((await m.put('/api/settings', { config: bad })).status).toBe(400)
    })
})

describe('GitHub webhook', () => {
    const sign = (body: string) => `sha256=${createHmac('sha256', HOOK_SECRET).update(body).digest('hex')}`

    it('rejects unsigned deliveries and applies signed ones', async () => {
        const body = JSON.stringify({ action: 'opened', repository: { full_name: 'demo-studio/tidepool-booking' }, issue: { number: 30, title: 'Fix timezone on bookings', state: 'open', html_url: 'https://github.com/demo-studio/tidepool-booking/issues/30', assignee: { login: 'sipho-demo' }, milestone: null } })
        const unsigned = await app.request('/api/github/webhook?company=co_demo', { method: 'POST', headers: { 'x-github-event': 'issues', 'content-type': 'application/json' }, body })
        expect(unsigned.status).toBe(401)
        const signed = await app.request('/api/github/webhook?company=co_demo', { method: 'POST', headers: { 'x-github-event': 'issues', 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body })
        expect(signed.status).toBe(200)
        const m = client(await signIn('thabo@demo.studio', 'demo-manager'))
        const tasks = (await m.get('/api/records/task?w.issue=30')).body.records
        expect(tasks[0]).toMatchObject({ title: 'Fix timezone on bookings', data: { assignee: 'usr_demo_sipho' } })
    })
})
