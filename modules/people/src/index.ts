import { defineModule, formatMoney, ValidationError, type Ctx, type StoredRecord, type TileData } from '@studio-os/core'
import { payslipFor, type PayrollSettings } from './payroll.ts'

export { payslipFor, annualTax, DEFAULT_PAYROLL, type PayrollSettings } from './payroll.ts'

const iso = (d: Date) => d.toISOString().slice(0, 10)

/** Monday of the week that holds `d`, as YYYY-MM-DD. */
export function weekStart(d: Date): string
{
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7))
    return iso(x)
}

/** Working days (Mon to Fri) from `from` to `to`, inclusive. */
export function workingDays(from: string, to: string): number
{
    let n = 0
    const d = new Date(`${from}T00:00:00Z`)
    const end = new Date(`${to}T00:00:00Z`)
    while (d <= end) {
        const day = d.getUTCDay()
        if (day !== 0 && day !== 6) n++
        d.setUTCDate(d.getUTCDate() + 1)
    }
    return n
}

async function hoursBetween(ctx: Ctx, from: string, to: string, userId?: string): Promise<Map<string, number>>
{
    const params: unknown[] = [ctx.companyId, from, to]
    let who = ''
    if (userId) {
        params.push(userId)
        who = ` and data->>'user' = $4`
    }
    const rows = await ctx.db.query<{ user_id: string; hours: string }>(
        `select data->>'user' as user_id, sum((data->>'hours')::numeric) as hours from records
         where company_id = $1 and type = 'time' and status in ('Logged', 'Approved')
           and data->>'date' >= $2 and data->>'date' <= $3${who}
         group by data->>'user'`,
        params,
    )
    return new Map(rows.map((r) => [r.user_id, Number(r.hours)]))
}

async function userNames(ctx: Ctx): Promise<Map<string, string>>
{
    const rows = await ctx.db.query<{ id: string; name: string }>('select id, name from users where company_id = $1 and active', [ctx.companyId])
    return new Map(rows.map((r) => [r.id, r.name]))
}

function settings(ctx: Ctx): Partial<PayrollSettings> & { leaveDays?: number; weeklyHours?: number }
{
    return (ctx.config.settings?.people ?? {}) as Partial<PayrollSettings> & { leaveDays?: number; weeklyHours?: number }
}

/**
 * People: staff profiles, time, leave and payslips. Time can be logged by
 * hand, or suggested from GitHub commits for the person to confirm.
 */
export default defineModule({
    id: 'people',
    name: 'People',
    description: 'Staff, timesheets, leave and payslips.',
    dependsOn: ['projects'],
    records: [
        {
            type: 'person',
            label: 'Staff member',
            plural: 'Staff',
            statuses: ['Active', 'Left'],
            fields: [
                { key: 'user', label: 'Login', kind: 'user', required: true },
                { key: 'jobTitle', label: 'Job title', kind: 'text' },
                { key: 'started', label: 'Started', kind: 'date' },
                { key: 'salary', label: 'Monthly salary', kind: 'money', sensitive: true },
                { key: 'costPerHour', label: 'Cost per hour', kind: 'money', sensitive: true },
                { key: 'taxNumber', label: 'Tax number', kind: 'text', sensitive: true },
                { key: 'bankAccount', label: 'Bank account', kind: 'text', sensitive: true },
                { key: 'leaveDays', label: 'Annual leave days', kind: 'number' },
                { key: 'github', label: 'GitHub login', kind: 'text' },
            ],
        },
        {
            type: 'time',
            label: 'Time entry',
            plural: 'Time',
            parent: 'project',
            visibility: 'assigned',
            assigneeField: 'user',
            statuses: ['Suggested', 'Logged', 'Approved'],
            fields: [
                { key: 'user', label: 'Person', kind: 'user', required: true },
                { key: 'date', label: 'Date', kind: 'date', required: true },
                { key: 'hours', label: 'Hours', kind: 'number', required: true },
                { key: 'project', label: 'Project', kind: 'record', recordType: 'project' },
                { key: 'task', label: 'Task', kind: 'record', recordType: 'task' },
                { key: 'note', label: 'What you did', kind: 'longtext' },
                { key: 'source', label: 'Source', kind: 'select', options: ['Manual', 'GitHub'] },
                { key: 'billable', label: 'Billable', kind: 'boolean' },
            ],
        },
        {
            type: 'leave',
            label: 'Leave',
            plural: 'Leave',
            visibility: 'assigned',
            assigneeField: 'user',
            statuses: ['Requested', 'Approved', 'Declined', 'Cancelled'],
            fields: [
                { key: 'user', label: 'Person', kind: 'user', required: true },
                { key: 'kind', label: 'Kind', kind: 'select', options: ['Annual', 'Sick', 'Family responsibility', 'Unpaid'], required: true },
                { key: 'from', label: 'From', kind: 'date', required: true },
                { key: 'to', label: 'To', kind: 'date', required: true },
                { key: 'days', label: 'Working days', kind: 'number' },
                { key: 'note', label: 'Note', kind: 'text' },
            ],
        },
        {
            type: 'payslip',
            label: 'Payslip',
            plural: 'Payslips',
            visibility: 'assigned',
            assigneeField: 'user',
            statuses: ['Draft', 'Issued'],
            fields: [
                { key: 'user', label: 'Person', kind: 'user', required: true },
                { key: 'month', label: 'Month', kind: 'text', required: true },
                { key: 'gross', label: 'Gross', kind: 'money', required: true },
                { key: 'paye', label: 'PAYE', kind: 'money' },
                { key: 'uif', label: 'UIF (employee)', kind: 'money' },
                { key: 'uifEmployer', label: 'UIF (employer)', kind: 'money', sensitive: true },
                { key: 'sdl', label: 'SDL', kind: 'money', sensitive: true },
                { key: 'net', label: 'Net pay', kind: 'money' },
                { key: 'taxTable', label: 'Tax table used', kind: 'text' },
            ],
        },
    ],
    emits: ['time.created', 'time.logged', 'leave.created', 'leave.approved', 'payslip.issued'],
    listens: {
        // Fill in the working days on a leave request so nobody counts by hand.
        'leave.created': async (ctx, event) => {
            const leave = event.payload.record as StoredRecord
            if (leave.data.days !== undefined && leave.data.days !== null) return
            const from = String(leave.data.from)
            const to = String(leave.data.to)
            if (to < from) return
            await ctx.records.update(leave.id, { data: { days: workingDays(from, to) } })
        },
    },
    actions: [
        {
            name: 'time.confirm',
            label: 'Confirm suggested time',
            description: 'Turns time suggested from GitHub activity into logged time, optionally changing the hours.',
            needsApproval: false,
            params: {
                timeId: { type: 'string', description: 'Time entry id', required: true },
                hours: { type: 'number', description: 'Hours, if different from the suggestion' },
            },
            async run(ctx, p) {
                const entry = await ctx.records.get(String(p.timeId))
                if (ctx.actor.kind === 'user' && ctx.actor.role !== 'manager' && entry.data.user !== ctx.actor.id) {
                    throw new ValidationError(['You can only confirm your own time'])
                }
                const updated = await ctx.records.update(entry.id, {
                    status: 'Logged',
                    data: typeof p.hours === 'number' ? { hours: p.hours } : {},
                })
                return { timeId: updated.id, hours: updated.data.hours }
            },
        },
        {
            name: 'leave.decide',
            label: 'Approve or decline leave',
            description: 'Approves or declines a leave request.',
            managersOnly: true,
            needsApproval: false,
            params: {
                leaveId: { type: 'string', description: 'Leave record id', required: true },
                approve: { type: 'boolean', description: 'true to approve', required: true },
            },
            async run(ctx, p) {
                const leave = await ctx.records.setStatus(String(p.leaveId), p.approve ? 'Approved' : 'Declined')
                return { leaveId: leave.id, status: leave.status }
            },
        },
        {
            name: 'payroll.draft_month',
            label: 'Draft payslips for a month',
            description: 'Drafts a payslip for every active staff member with a salary. Check them before issuing.',
            managersOnly: true,
            needsApproval: false,
            params: { month: { type: 'string', description: 'YYYY-MM', required: true } },
            async run(ctx, p) {
                const month = String(p.month)
                if (!/^\d{4}-\d{2}$/.test(month)) throw new ValidationError(['Month must look like 2026-11'])
                const staff = await ctx.records.list('person', { status: 'Active' })
                const created: string[] = []
                for (const person of staff) {
                    const gross = Number(person.data.salary ?? 0)
                    if (gross <= 0) continue
                    const userId = String(person.data.user)
                    const existing = await ctx.records.list('payslip', { where: { user: userId, month } })
                    if (existing.length > 0) continue
                    const slip = payslipFor(gross, settings(ctx))
                    const rec = await ctx.records.create({
                        type: 'payslip',
                        title: `${person.title} · ${month}`,
                        data: { user: userId, month, ...slip },
                    })
                    created.push(rec.id)
                }
                return { created }
            },
        },
        {
            name: 'payslip.issue',
            label: 'Issue a payslip',
            description: 'Makes a checked payslip visible to the staff member.',
            managersOnly: true,
            needsApproval: false,
            params: { payslipId: { type: 'string', description: 'Payslip id', required: true } },
            async run(ctx, p) {
                const slip = await ctx.records.setStatus(String(p.payslipId), 'Issued')
                return { payslipId: slip.id }
            },
        },
    ],
    tiles: [
        { id: 'people.team_week', title: 'Team this week', sides: ['manage'], size: 'md', load: teamWeek },
        { id: 'people.whos_out', title: "Who's out", sides: ['manage', 'employee'], size: 'sm', load: whosOut },
        { id: 'people.payroll', title: 'Payroll', sides: ['manage'], size: 'sm', load: payrollTile },
        { id: 'people.my_week', title: 'My week', sides: ['employee'], size: 'md', load: myWeek },
        { id: 'people.my_leave', title: 'My leave', sides: ['employee'], size: 'sm', load: myLeave },
    ],
})

async function teamWeek(ctx: Ctx): Promise<TileData>
{
    const from = weekStart(ctx.now())
    const to = iso(ctx.now())
    const [hours, names] = await Promise.all([hoursBetween(ctx, from, to), userNames(ctx)])
    const target = (settings(ctx).weeklyHours ?? 40) * Math.min(workingDays(from, to), 5) / 5
    const items = [...names.entries()].map(([id, name]) => {
        const h = hours.get(id) ?? 0
        const pct = target > 0 ? Math.round((h / target) * 100) : 0
        return { label: name, detail: `${h.toFixed(1)} h logged (${pct}% of ${target.toFixed(0)} h so far)`, tone: (pct < 50 ? 'warning' : 'neutral') as TileData['tone'] }
    })
    const total = [...hours.values()].reduce((a, b) => a + b, 0)
    return { value: `${total.toFixed(1)} h`, caption: 'logged since Monday', items }
}

async function whosOut(ctx: Ctx): Promise<TileData>
{
    const today = iso(ctx.now())
    const week = new Date(ctx.now())
    week.setUTCDate(week.getUTCDate() + 7)
    const leave = (await ctx.records.list('leave', { status: 'Approved' })).filter((l) => String(l.data.to) >= today && String(l.data.from) <= iso(week))
    const names = await userNames(ctx)
    const outNow = leave.filter((l) => String(l.data.from) <= today)
    return {
        value: String(outNow.length),
        caption: outNow.length === 1 ? 'person out today' : 'people out today',
        items: leave.map((l) => ({ label: names.get(String(l.data.user)) ?? 'Someone', detail: `${l.data.kind} · ${l.data.from} to ${l.data.to}` })),
    }
}

async function payrollTile(ctx: Ctx): Promise<TileData>
{
    const staff = await ctx.records.list('person', { status: 'Active' })
    const s = settings(ctx)
    let cost = 0
    for (const p of staff) {
        const gross = Number(p.data.salary ?? 0)
        if (gross <= 0) continue
        const slip = payslipFor(gross, s)
        cost += gross + slip.uifEmployer + slip.sdl
    }
    const now = ctx.now()
    const payday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), (s.payday as number | undefined) ?? 25))
    return {
        value: formatMoney(cost, ctx.config.currency),
        caption: `monthly cost to company · next payday ${iso(payday < now ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, payday.getUTCDate())) : payday)}`,
    }
}

async function myWeek(ctx: Ctx): Promise<TileData>
{
    const from = weekStart(ctx.now())
    const to = iso(ctx.now())
    const hours = (await hoursBetween(ctx, from, to, ctx.actor.id)).get(ctx.actor.id) ?? 0
    const suggested = await ctx.records.list('time', { status: 'Suggested', where: { user: ctx.actor.id } })
    return {
        value: `${hours.toFixed(1)} h`,
        caption: suggested.length ? `logged, ${suggested.length} suggested from GitHub to confirm` : 'logged this week',
        tone: suggested.length ? 'warning' : 'neutral',
        items: suggested.slice(0, 6).map((t) => ({
            label: `${t.data.date} · ${t.data.hours} h`,
            detail: String(t.data.note ?? ''),
            href: `/records/${t.id}`,
        })),
    }
}

async function myLeave(ctx: Ctx): Promise<TileData>
{
    const year = ctx.now().getUTCFullYear()
    const people = await ctx.records.list('person', { where: { user: ctx.actor.id } })
    const allowance = Number(people[0]?.data.leaveDays ?? settings(ctx).leaveDays ?? 15)
    const taken = (await ctx.records.list('leave', { status: 'Approved', where: { user: ctx.actor.id, kind: 'Annual' } }))
        .filter((l) => String(l.data.from).startsWith(String(year)))
        .reduce((s, l) => s + Number(l.data.days ?? 0), 0)
    return { value: `${allowance - taken} days`, caption: `annual leave left of ${allowance}` }
}
