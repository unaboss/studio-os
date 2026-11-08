import { AGENT, createContext, DEFAULT_CONFIG, SYSTEM, type Actor, type CompanyConfig, type Ctx, type Db } from '@studio-os/core'
import { runMorning } from '@studio-os/agent'
import { startProject } from '@studio-os/module-projects'
import { importBankLines, withFingerprints } from '@studio-os/module-money'
import { hashPassword } from './auth.ts'
import { Companies } from './studio.ts'

export const DEMO_COMPANY = 'co_demo'

const DEMO_CONFIG: CompanyConfig = {
    ...DEFAULT_CONFIG,
    theme: { accent: '#0f766e', name: 'Demo Studio' },
    settings: {
        compliance: { yearEndMonth: 2, vatRegistered: true, vatPeriods: 'odd', incorporated: '2022-06-14' },
        people: { payday: 25, leaveDays: 18 },
    },
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
const daysAgo = (now: Date, n: number) => iso(new Date(now.getTime() - n * 86_400_000))

/**
 * A believable small studio, all made up: three people, four clients,
 * three projects, a bank feed, deadlines and an overdue invoice. Used for
 * the public demo and for trying Studio OS out. No real client or bank data.
 */
export async function seedDemo(db: Db, opts: { reset?: boolean; now?: Date } = {}): Promise<void>
{
    const now = opts.now ?? new Date()
    const exists = await db.query('select 1 from companies where id = $1', [DEMO_COMPANY])
    if (exists.length > 0) {
        if (!opts.reset) return
        for (const table of ['approvals', 'automations', 'events', 'bank_parsers']) await db.query(`delete from ${table} where company_id = $1`, [DEMO_COMPANY])
        await db.query('update records set parent_id = null where company_id = $1', [DEMO_COMPANY])
        await db.query('delete from records where company_id = $1', [DEMO_COMPANY])
        await db.query('delete from users where company_id = $1', [DEMO_COMPANY])
        await db.query('delete from companies where id = $1', [DEMO_COMPANY])
    }
    await db.query('insert into companies (id, name, config) values ($1, $2, $3::jsonb)', [DEMO_COMPANY, 'Demo Studio', JSON.stringify(DEMO_CONFIG)])

    const people: (Actor & { email: string; password: string; github: string })[] = [
        { id: 'usr_demo_thabo', kind: 'user', role: 'manager', name: 'Thabo Nkosi', email: 'thabo@demo.studio', password: 'demo-manager', github: 'thabo-demo' },
        { id: 'usr_demo_lerato', kind: 'user', role: 'employee', name: 'Lerato Mokoena', email: 'lerato@demo.studio', password: 'demo-employee', github: 'lerato-demo' },
        { id: 'usr_demo_sipho', kind: 'user', role: 'employee', name: 'Sipho Dlamini', email: 'sipho@demo.studio', password: crypto.randomUUID(), github: 'sipho-demo' },
    ]
    for (const p of people) {
        await db.query(
            'insert into users (id, company_id, email, name, role, password_hash, github_login) values ($1, $2, $3, $4, $5, $6, $7)',
            [p.id, DEMO_COMPANY, p.email, p.name, p.role, await hashPassword(p.password), p.github],
        )
    }
    const [thabo, lerato, sipho] = people as [typeof people[0], typeof people[0], typeof people[0]]

    const registry = await new Companies(db).registry(DEMO_COMPANY)
    let clock = new Date(now)
    const as = (actor: Actor): Ctx => createContext({ db, companyId: DEMO_COMPANY, actor, registry, now: () => clock })
    const m = as(thabo)
    const sys = as(SYSTEM)

    // Staff
    const staff = [
        { who: thabo, title: 'Founder and lead developer', salary: 4_500_000, started: '2022-06-14' },
        { who: lerato, title: 'Full-stack developer', salary: 3_200_000, started: '2024-02-01' },
        { who: sipho, title: 'Junior developer', salary: 1_800_000, started: '2025-09-01' },
    ]
    for (const s of staff) {
        await m.records.create({ type: 'person', title: s.who.name, data: { user: s.who.id, jobTitle: s.title, salary: s.salary, started: s.started, github: s.who.github, leaveDays: 18 } })
    }

    // Clients and projects
    const client = async (title: string, contact: string, email: string) =>
        m.records.create({ type: 'client', title, status: 'Active', data: { contact, email } })
    const karoo = await client('Karoo Coffee Roasters', 'Anele Botha', 'anele@karoocoffee.example')
    const tidepool = await client('Tidepool Dive School', 'Megan Pillay', 'megan@tidepool.example')
    const marula = await client('Marula Health Clinic', 'Dr Naledi Khumalo', 'admin@marulahealth.example')
    await m.records.create({ type: 'client', title: 'Ubuntu Freight', status: 'Prospect', data: { contact: 'Johan van Wyk', email: 'johan@ubuntufreight.example' } })

    clock = new Date(now.getTime() - 60 * 86_400_000)
    const ordering = await startProject(m, { clientId: karoo.id, title: 'Online ordering app', projectType: 'build', valueCents: 12_000_000, repo: 'demo-studio/karoo-ordering', due: daysAgo(now, -40) })
    clock = new Date(now.getTime() - 35 * 86_400_000)
    const booking = await startProject(m, { clientId: tidepool.id, title: 'Booking website', projectType: 'small', valueCents: 3_800_000, repo: 'demo-studio/tidepool-booking', due: daysAgo(now, 6) })
    clock = new Date(now.getTime() - 20 * 86_400_000)
    const portal = await startProject(m, { clientId: marula.id, title: 'Patient booking portal', projectType: 'build', valueCents: 18_500_000, repo: 'demo-studio/marula-portal', due: daysAgo(now, -90) })
    for (const p of [ordering, booking, portal]) {
        await m.records.update(String(p.projectId), { data: { members: [thabo.id, lerato.id, sipho.id], lead: thabo.id } })
    }

    // Tasks
    const orderingPhases = ordering.phaseIds as string[]
    const bookingPhases = booking.phaseIds as string[]
    const portalPhases = portal.phaseIds as string[]
    const task = async (projectId: unknown, phase: string, title: string, status: string, assignee: string, due: number | null, issue: number) =>
        m.records.create({
            type: 'task',
            title,
            status,
            parentId: String(projectId),
            data: { phase, assignee, issue, ...(due === null ? {} : { due: daysAgo(now, -due) }) },
        })

    // Ordering app: discovery done 3 weeks ago, build under way.
    clock = new Date(now.getTime() - 24 * 86_400_000)
    await task(ordering.projectId, orderingPhases[0]!, 'Menu and checkout wireframes', 'Done', lerato.id, null, 1)
    await task(ordering.projectId, orderingPhases[0]!, 'Payment provider decision', 'Done', thabo.id, null, 2)
    // Closing discovery drafts its 40% invoice.
    await m.records.setStatus(orderingPhases[0]!, 'Done')
    await m.records.setStatus(orderingPhases[1]!, 'In progress')
    clock = new Date(now)
    await task(ordering.projectId, orderingPhases[1]!, 'Cart and checkout screens', 'In review', lerato.id, 2, 14)
    await task(ordering.projectId, orderingPhases[1]!, 'Yoco payments integration', 'In progress', thabo.id, 5, 15)
    await task(ordering.projectId, orderingPhases[1]!, 'Order notifications for baristas', 'To do', sipho.id, 9, 16)
    await task(ordering.projectId, orderingPhases[1]!, 'Loyalty stamps', 'To do', lerato.id, 14, 17)

    // Booking site: nearly finished, due in six days.
    await task(booking.projectId, bookingPhases[0]!, 'Course calendar', 'Done', lerato.id, null, 3)
    await task(booking.projectId, bookingPhases[1]!, 'Deposit payments', 'In progress', sipho.id, 3, 8)
    await task(booking.projectId, bookingPhases[1]!, 'Go-live checklist', 'To do', thabo.id, 6, 9)

    // Portal: discovery.
    await task(portal.projectId, portalPhases[0]!, 'POPIA data map', 'In progress', thabo.id, 4, 1)
    await task(portal.projectId, portalPhases[0]!, 'Clinic workflow interviews', 'To do', lerato.id, 7, 2)

    // Invoices: the ordering app's deposit was paid; the booking site's first half is overdue.
    const [orderingDeposit] = await m.records.list('invoice', { parentId: String(ordering.projectId) })
    const bookingInvoice = (await m.actions.request('invoice.draft', { projectId: String(booking.projectId), amountCents: 1_900_000, description: 'Booking website: deposit and build (50%)' }))
    clock = new Date(now.getTime() - 30 * 86_400_000)
    if (bookingInvoice.status === 'done') await m.actions.request('invoice.send', { invoiceId: String(bookingInvoice.result.invoiceId) })
    clock = new Date(now.getTime() - 23 * 86_400_000)
    if (orderingDeposit) await m.actions.request('invoice.send', { invoiceId: orderingDeposit.id })
    clock = new Date(now)
    // A draft from the portal's planning, ready to send.
    await m.actions.request('invoice.draft', { projectId: String(portal.projectId), amountCents: 2_500_000, description: 'Patient booking portal: discovery workshop' })

    // Ninety days of bank lines.
    const lines: { date: string; amount: number; description: string; reference: string | null; balance: number | null }[] = []
    let balance = 38_000_000
    const add = (d: number, amount: number, description: string) => {
        balance += amount
        lines.push({ date: daysAgo(now, d), amount, description, reference: null, balance })
    }
    for (let d = 90; d >= 1; d--) {
        const date = new Date(now.getTime() - d * 86_400_000)
        const day = date.getUTCDate()
        if (day === 1) add(d, -1_150_000, 'DEBIT ORDER OFFICE RENT WORKSHOP17')
        if (day === 3) add(d, -45_870, 'VULTR.COM CLOUD SERVICES')
        if (day === 5) add(d, -38_000, 'GITHUB.COM TEAM')
        if (day === 6) add(d, -62_400, 'GOOGLE WORKSPACE')
        if (day === 7) add(d, -1_412_000, 'SARS EMP201 PAYE UIF')
        if (day === 12) add(d, -89_900, 'TELKOM FIBRE')
        if (day === 25) add(d, -8_160_000, 'SALARIES')
        if (day === 15) add(d, 4_850_000, 'NEXUS LOGISTICS RETAINER')
        if (d === 64) add(d, 6_200_000, 'FINAL PAYMENT OLD PROJECT')
        if (d === 18 && orderingDeposit) add(d, 4_800_000, `KAROO COFFEE ${String(orderingDeposit.data.number)}`)
        if (d === 9) add(d, -186_000, 'TAKEALOT MONITOR')
    }
    await importBankLines(m, withFingerprints(lines), 'Business cheque')
    await m.actions.request('bank.auto_match', {})

    // Expense claims, leave, time.
    const lerCtx = as(lerato)
    await lerCtx.records.create({ type: 'expense', title: 'Uber to Karoo Coffee workshop', data: { claimant: lerato.id, amount: 18_640, date: daysAgo(now, 3), category: 'Travel', project: String(ordering.projectId) } })
    await as(sipho).records.create({ type: 'expense', title: 'Data bundle for client site visit', data: { claimant: sipho.id, amount: 29_900, date: daysAgo(now, 6), category: 'Data and airtime' } })
    const leave = await as(sipho).records.create({ type: 'leave', title: 'Family wedding', data: { user: sipho.id, kind: 'Annual', from: daysAgo(now, -4), to: daysAgo(now, -6) } })
    await m.actions.request('leave.decide', { leaveId: leave.id, approve: true })
    await lerCtx.records.create({ type: 'leave', title: 'Dentist', data: { user: lerato.id, kind: 'Sick', from: daysAgo(now, -9), to: daysAgo(now, -9) } })

    const monday = new Date(now)
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
    for (let i = 0; iso(new Date(monday.getTime() + i * 86_400_000)) < iso(now); i++) {
        const date = iso(new Date(monday.getTime() + i * 86_400_000))
        for (const [who, hours, projectId, note] of [
            [lerato, 7, ordering.projectId, 'Checkout screens'],
            [sipho, 6.5, booking.projectId, 'Deposit payments'],
            [thabo, 5, portal.projectId, 'POPIA data map'],
        ] as const) {
            await as(who).records.create({ type: 'time', title: `${note} · ${date}`, status: 'Logged', parentId: String(projectId), data: { user: who.id, date, hours, project: String(projectId), note, source: 'Manual', billable: true } })
        }
    }
    await sys.records.create({
        type: 'time',
        title: `Online ordering app · ${iso(now)}`,
        status: 'Suggested',
        parentId: String(ordering.projectId),
        data: { user: lerato.id, date: iso(now), hours: 3.5, project: String(ordering.projectId), note: '• Cart totals with VAT\n• Fix checkout on small phones\n• Review fixes', source: 'GitHub', billable: true },
    })
    await sys.records.create({
        type: 'review',
        title: 'Yoco payments integration',
        parentId: String(ordering.projectId),
        data: { user: lerato.id, repo: 'demo-studio/karoo-ordering', pr: 21, url: 'https://github.com/demo-studio/karoo-ordering/pull/21', author: 'thabo-demo', project: String(ordering.projectId) },
    })

    // Sales
    const lead = async (title: string, data: Record<string, unknown>, status: string) => m.records.create({ type: 'lead', title, status, data })
    await lead('Fleet tracking dashboard', { company: 'Ubuntu Freight', contact: 'Johan van Wyk', value: 22_000_000, projectType: 'build', source: 'Referral', nextStep: 'Send proposal', followUp: daysAgo(now, 0) }, 'Talking')
    await lead('School fees app', { company: 'Hillcrest Prep', contact: 'Mrs Govender', value: 9_500_000, projectType: 'build', source: 'Website', nextStep: 'Call about budget', followUp: daysAgo(now, -3) }, 'Proposal sent')
    await lead('Shopify clean-up', { company: 'Stoep Ceramics', value: 1_800_000, projectType: 'small', source: 'LinkedIn', nextStep: 'Reply to email', followUp: daysAgo(now, 1) }, 'New')

    // Deadlines and rules.
    await m.actions.request('compliance.seed', {})
    const rules = [
        { id: 'auto_demo_chase', name: 'Chase invoices a week late', when: 'invoice.overdue', conditions: [{ path: 'payload.daysOverdue', op: 'eq', value: 7 }], action: 'invoice.send_reminder', params: { invoiceId: '{{payload.invoiceId}}' } },
        { id: 'auto_demo_send', name: 'Queue new phase invoices to send', when: 'invoice.created', conditions: [{ path: 'payload.record.data.phase', op: 'exists' }], action: 'invoice.send', params: { invoiceId: '{{payload.record.id}}' } },
    ]
    for (const r of rules) {
        await db.query(
            'insert into automations (id, company_id, name, when_event, conditions, action, params) values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)',
            [r.id, DEMO_COMPANY, r.name, r.when, JSON.stringify(r.conditions), r.action, JSON.stringify(r.params)],
        )
    }

    // A week of shipping, as the GitHub webhook would have recorded it.
    const shipped = [
        { name: 'github.pr_merged', project: ordering.projectId, repo: 'demo-studio/karoo-ordering', payload: { number: 18, title: 'Menu screen with live stock', author: 'lerato-demo' } },
        { name: 'github.pr_merged', project: booking.projectId, repo: 'demo-studio/tidepool-booking', payload: { number: 7, title: 'Course calendar', author: 'lerato-demo' } },
        { name: 'github.checks_failed', project: booking.projectId, repo: 'demo-studio/tidepool-booking', payload: { name: 'CI', branch: 'deposit-payments' } },
        { name: 'github.pr_merged', project: portal.projectId, repo: 'demo-studio/marula-portal', payload: { number: 2, title: 'Project skeleton and POPIA notes', author: 'thabo-demo' } },
    ]
    for (const e of shipped) {
        await sys.events.emit(e.name, {
            recordId: String(e.project),
            payload: { repo: e.repo, projectId: String(e.project), url: `https://github.com/${e.repo}`, ...e.payload },
        })
    }

    await runMorning(as(AGENT), null)
}

export interface Showcase
{
    /** A real person to add to the demo team, matched to commits by name. */
    readonly owner?: { name: string; github: string }
    /** The client the real projects sit under. */
    readonly client: string
    readonly repos: readonly { repo: string; title: string }[]
}

/** Reads the showcase from DEMO_OWNER ("Name|login"), DEMO_CLIENT and DEMO_REPOS ("owner/name=Title,…"). */
export function showcaseFromEnv(env: Record<string, string | undefined>): Showcase | null
{
    const repos = (env.DEMO_REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean).flatMap((s) => {
        const [repo, title] = s.split('=').map((x) => x.trim()) as [string, string | undefined]
        return /^[\w.-]+\/[\w.-]+$/.test(repo) ? [{ repo, title: title || repo.split('/')[1]! }] : []
    })
    if (!repos.length) return null
    const [name, github] = (env.DEMO_OWNER ?? '').split('|').map((x) => x.trim())
    return { owner: name && github ? { name, github } : undefined, client: env.DEMO_CLIENT?.trim() || repos[0]!.repo.split('/')[0]!, repos }
}

/**
 * Adds real people and real public repos to the demo studio, next to the
 * made-up ones, so visitors see real trees and a real contribution graph.
 * Safe to run on every start: it only adds what is missing.
 */
export async function seedShowcase(db: Db, show: Showcase, opts: { now?: Date } = {}): Promise<void>
{
    const company = await db.query('select 1 from companies where id = $1', [DEMO_COMPANY])
    if (company.length === 0) return
    const registry = await new Companies(db).registry(DEMO_COMPANY)
    const lead: Actor = { id: 'usr_demo_thabo', kind: 'user', role: 'manager', name: 'Thabo Nkosi' }
    const ctx = createContext({ db, companyId: DEMO_COMPANY, actor: lead, registry, now: () => opts.now ?? new Date() })

    let ownerId: string | null = null
    if (show.owner) {
        ownerId = 'usr_demo_owner'
        const exists = await db.query('select 1 from users where id = $1', [ownerId])
        if (exists.length === 0) {
            // Nobody signs in as this person: the password is random and never shown.
            await db.query(
                'insert into users (id, company_id, email, name, role, password_hash, github_login) values ($1, $2, $3, $4, $5, $6, $7)',
                [ownerId, DEMO_COMPANY, `${show.owner.github.toLowerCase()}@users.noreply.github.com`, show.owner.name, 'manager', await hashPassword(crypto.randomUUID()), show.owner.github],
            )
            await ctx.records.create({ type: 'person', title: show.owner.name, data: { user: ownerId, jobTitle: 'Founder', github: show.owner.github, leaveDays: 18 } })
        }
    }

    const projects = await ctx.records.list('project', { limit: 1000 })
    const missing = show.repos.filter((r) => !projects.some((p) => String(p.data.repo ?? '').toLowerCase() === r.repo.toLowerCase()))
    if (!missing.length) return
    const clients = await ctx.records.list('client', { limit: 1000 })
    const client = clients.find((c) => c.title.toLowerCase() === show.client.toLowerCase())
        ?? await ctx.records.create({ type: 'client', title: show.client, status: 'Active', data: {} })
    const members = (await db.query<{ id: string }>('select id from users where company_id = $1 and active', [DEMO_COMPANY])).map((u) => u.id)
    for (const r of missing) {
        await ctx.records.create({ type: 'project', title: r.title, status: 'Active', parentId: client.id, data: { client: client.id, projectType: 'build', repo: r.repo, lead: ownerId ?? lead.id, members } })
    }
}

if (process.argv[1]?.endsWith('seed.ts')) {
    const { connect } = await import('./server.ts')
    const { db, close } = await connect()
    await seedDemo(db, { reset: process.argv.includes('--reset') })
    console.log('Demo studio ready: thabo@demo.studio / demo-manager, lerato@demo.studio / demo-employee')
    await close()
}
