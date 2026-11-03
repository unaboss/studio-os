import { daysBetween, defineModule, type Ctx, type StoredRecord, type TileData } from '@studio-os/core'

const OPEN = ['Upcoming', 'Overdue']
const RECURS: Record<string, number> = { Monthly: 1, 'Every two months': 2, 'Every six months': 6, Yearly: 12 }

const iso = (d: Date) => d.toISOString().slice(0, 10)

function lastDayOfMonth(year: number, month0: number): Date
{
    return new Date(Date.UTC(year, month0 + 1, 0))
}

/** Moves a weekend date back to the Friday before (SARS's rule for due dates). */
export function businessDayOnOrBefore(d: Date): Date
{
    const x = new Date(d)
    while (x.getUTCDay() === 0 || x.getUTCDay() === 6) x.setUTCDate(x.getUTCDate() - 1)
    return x
}

export function addMonths(isoDate: string, months: number): string
{
    const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number]
    const last = lastDayOfMonth(y, m - 1 + months).getUTCDate()
    return iso(new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))))
}

interface ComplianceSettings
{
    /** Month the financial year ends, 1 to 12. Most small companies: 2 (February). */
    readonly yearEndMonth?: number
    /** Date of incorporation, for the CIPC annual return. */
    readonly incorporated?: string
    readonly vatRegistered?: boolean
    /** VAT category B periods end in odd months (Jan, Mar...), or even months. */
    readonly vatPeriods?: 'odd' | 'even'
    readonly hasEmployees?: boolean
}

interface Deadline
{
    readonly title: string
    readonly kind: string
    readonly period: string
    readonly due: string
    readonly recurs: string
}

/**
 * The South African deadlines a small company faces, for the twelve months
 * from `from`. Public holidays are not taken into account, so a deadline
 * on a holiday shows a day late: check SARS's calendar for those.
 */
export function deadlinesFor(from: Date, s: ComplianceSettings): Deadline[]
{
    const out: Deadline[] = []
    const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())
    const end = Date.UTC(from.getUTCFullYear() + 1, from.getUTCMonth(), from.getUTCDate())
    const push = (d: Deadline) => {
        const t = Date.parse(`${d.due}T00:00:00Z`)
        if (t >= start && t < end) out.push(d)
    }
    const y0 = from.getUTCFullYear()

    if (s.hasEmployees !== false) {
        for (let i = 0; i < 13; i++) {
            const periodEnd = lastDayOfMonth(y0, from.getUTCMonth() - 1 + i)
            const due = businessDayOnOrBefore(new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() + 1, 7)))
            const period = iso(periodEnd).slice(0, 7)
            push({ title: `EMP201 for ${period}`, kind: 'EMP201', period, due: iso(due), recurs: 'Monthly' })
        }
        for (const y of [y0, y0 + 1]) {
            push({ title: `EMP501 interim reconciliation ${y}`, kind: 'EMP501', period: `${y}-interim`, due: iso(businessDayOnOrBefore(new Date(Date.UTC(y, 9, 31)))), recurs: 'Yearly' })
            push({ title: `EMP501 annual reconciliation ${y}`, kind: 'EMP501', period: `${y}-annual`, due: iso(businessDayOnOrBefore(new Date(Date.UTC(y, 4, 31)))), recurs: 'Yearly' })
        }
    }

    const yem = (s.yearEndMonth ?? 2) - 1
    for (const y of [y0 - 1, y0, y0 + 1, y0 + 2]) {
        const yearEnd = lastDayOfMonth(y, yem)
        const firstIrp6 = businessDayOnOrBefore(lastDayOfMonth(y, yem - 6))
        push({ title: `Provisional tax (IRP6) first payment, year ending ${iso(yearEnd)}`, kind: 'IRP6', period: `${iso(yearEnd)}-1`, due: iso(firstIrp6), recurs: 'Yearly' })
        push({ title: `Provisional tax (IRP6) second payment, year ending ${iso(yearEnd)}`, kind: 'IRP6', period: `${iso(yearEnd)}-2`, due: iso(businessDayOnOrBefore(yearEnd)), recurs: 'Yearly' })
        push({ title: `Company tax return (ITR14), year ending ${iso(yearEnd)}`, kind: 'ITR14', period: iso(yearEnd), due: iso(businessDayOnOrBefore(lastDayOfMonth(y + 1, yem))), recurs: 'Yearly' })
    }

    if (s.vatRegistered) {
        const odd = (s.vatPeriods ?? 'odd') === 'odd'
        for (let i = -1; i < 13; i++) {
            const periodEnd = lastDayOfMonth(y0, from.getUTCMonth() + i)
            const month1 = periodEnd.getUTCMonth() + 1
            if ((month1 % 2 === 1) !== odd) continue
            const due = businessDayOnOrBefore(lastDayOfMonth(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() + 1))
            const period = iso(periodEnd).slice(0, 7)
            push({ title: `VAT201 for the period ending ${period}`, kind: 'VAT201', period, due: iso(due), recurs: 'Every two months' })
        }
    }

    if (s.incorporated && /^\d{4}-\d{2}-\d{2}$/.test(s.incorporated)) {
        for (const y of [y0, y0 + 1]) {
            const anniversary = `${y}${s.incorporated.slice(4)}`
            // CIPC allows 30 business days from the anniversary.
            const d = new Date(`${anniversary}T00:00:00Z`)
            let left = 30
            while (left > 0) {
                d.setUTCDate(d.getUTCDate() + 1)
                if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--
            }
            push({ title: `CIPC annual return ${y}`, kind: 'CIPC annual return', period: String(y), due: iso(d), recurs: 'Yearly' })
        }
    }
    return out.sort((a, b) => a.due.localeCompare(b.due))
}

/**
 * Compliance: the tax and company deadlines that cost a small studio money
 * when they slip. Seeded from a few settings, then kept by hand.
 */
export default defineModule({
    id: 'compliance',
    name: 'Compliance',
    description: 'SARS and CIPC deadlines, with reminders.',
    records: [
        {
            type: 'obligation',
            label: 'Deadline',
            plural: 'Deadlines',
            visibility: 'managers',
            statuses: ['Upcoming', 'Done', 'Overdue', 'Not needed'],
            fields: [
                { key: 'kind', label: 'Kind', kind: 'select', options: ['EMP201', 'EMP501', 'VAT201', 'IRP6', 'ITR14', 'CIPC annual return', 'B-BBEE affidavit', 'Other'], required: true },
                { key: 'period', label: 'Period', kind: 'text' },
                { key: 'due', label: 'Due', kind: 'date', required: true },
                { key: 'amount', label: 'Amount paid', kind: 'money' },
                { key: 'recurs', label: 'Repeats', kind: 'select', options: ['Never', ...Object.keys(RECURS)] },
                { key: 'notes', label: 'Notes', kind: 'longtext' },
            ],
        },
    ],
    emits: ['obligation.due_soon', 'obligation.overdue', 'obligation.done'],
    actions: [
        {
            name: 'compliance.seed',
            label: 'Add the standard deadlines',
            description: 'Adds the next twelve months of SARS and CIPC deadlines from the company settings, skipping ones already there.',
            managersOnly: true,
            needsApproval: false,
            params: {},
            async run(ctx) {
                const s = (ctx.config.settings?.compliance ?? {}) as ComplianceSettings
                const existing = await ctx.records.list('obligation', { limit: 2000 })
                const have = new Set(existing.map((o) => `${o.data.kind}|${o.data.period}`))
                let added = 0
                for (const d of deadlinesFor(ctx.now(), s)) {
                    if (have.has(`${d.kind}|${d.period}`)) continue
                    await ctx.records.create({ type: 'obligation', title: d.title, data: { kind: d.kind, period: d.period, due: d.due, recurs: 'Never' } })
                    added++
                }
                return { added }
            },
        },
        {
            name: 'compliance.done',
            label: 'Mark a deadline done',
            description: 'Marks a deadline done and, if it repeats, adds the next one.',
            managersOnly: true,
            needsApproval: false,
            params: {
                obligationId: { type: 'string', description: 'Deadline record id', required: true },
                amountCents: { type: 'number', description: 'Amount paid, if any' },
            },
            async run(ctx, p) {
                const o = await ctx.records.update(String(p.obligationId), {
                    status: 'Done',
                    data: typeof p.amountCents === 'number' ? { amount: p.amountCents } : {},
                })
                const months = RECURS[String(o.data.recurs ?? 'Never')]
                let nextId: string | null = null
                if (months) {
                    const next = await ctx.records.create({
                        type: 'obligation',
                        title: o.title,
                        data: { kind: o.data.kind, due: addMonths(String(o.data.due), months), recurs: o.data.recurs },
                    })
                    nextId = next.id
                }
                return { obligationId: o.id, nextId }
            },
        },
        {
            name: 'compliance.check',
            label: 'Check deadlines',
            description: 'Marks missed deadlines overdue and raises obligation.due_soon for those in the next 7 days.',
            needsApproval: false,
            params: { days: { type: 'number', description: 'How far ahead to warn, in days (default 7)' } },
            async run(ctx, p) {
                const ahead = typeof p.days === 'number' ? p.days : 7
                const open = await ctx.records.list('obligation', { status: OPEN })
                const soon: string[] = []
                const overdue: string[] = []
                for (const o of open) {
                    const left = -daysBetween(String(o.data.due), ctx.now())
                    if (left < 0 && o.status !== 'Overdue') {
                        await ctx.records.setStatus(o.id, 'Overdue')
                        overdue.push(o.id)
                    } else if (left >= 0 && left <= ahead) {
                        await ctx.events.emit('obligation.due_soon', { recordId: o.id, payload: { record: o, daysLeft: left } })
                        soon.push(o.id)
                    }
                }
                return { soon, overdue }
            },
        },
    ],
    tiles: [
        {
            id: 'compliance.next',
            title: 'Deadlines',
            sides: ['manage'],
            size: 'md',
            async load(ctx: Ctx): Promise<TileData> {
                const open = (await ctx.records.list('obligation', { status: OPEN })).sort((a, b) => String(a.data.due).localeCompare(String(b.data.due)))
                const overdue = open.filter((o) => o.status === 'Overdue')
                const next = open[0]
                if (!next) return { value: 'Clear', caption: 'No deadlines on file. Add the standard ones in Compliance.', tone: 'neutral' }
                const left = -daysBetween(String(next.data.due), ctx.now())
                return {
                    value: overdue.length ? `${overdue.length} overdue` : left === 0 ? 'Today' : `${left} days`,
                    caption: overdue.length ? 'deadlines missed' : `until ${next.title}`,
                    tone: overdue.length ? 'critical' : left <= 3 ? 'warning' : 'good',
                    items: open.slice(0, 6).map((o: StoredRecord) => ({
                        label: o.title,
                        detail: `${o.status === 'Overdue' ? 'Overdue since' : 'Due'} ${o.data.due}`,
                        href: `/records/${o.id}`,
                        tone: (o.status === 'Overdue' ? 'critical' : 'neutral') as TileData['tone'],
                    })),
                }
            },
        },
    ],
})

