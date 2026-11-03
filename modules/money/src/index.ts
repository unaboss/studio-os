import
{
    daysBetween,
    defineModule,
    formatMoney,
    splitByShares,
    ValidationError,
    type Ctx,
    type StoredRecord,
    type TileData,
} from '@studio-os/core'
import { parseBankCsv } from './bank-csv.ts'

export { parseBankCsv, type BankLine } from './bank-csv.ts'

const OPEN_INVOICE = ['Sent', 'Part paid']

/** Sends mail outside the company. The app supplies it; tests use a fake. */
export interface MailService
{
    send(msg: { to: string; subject: string; text: string }): Promise<{ id: string }>
}

const today = (ctx: Ctx) => ctx.now().toISOString().slice(0, 10)

function addDays(isoDate: string, days: number): string
{
    const d = new Date(`${isoDate}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + days)
    return d.toISOString().slice(0, 10)
}

export function amountDue(inv: StoredRecord): number
{
    return Number(inv.data.amount ?? 0) - Number(inv.data.paid ?? 0)
}

async function nextInvoiceNumber(ctx: Ctx): Promise<string>
{
    const prefix = String(ctx.config.settings?.money?.invoicePrefix ?? 'INV-')
    const rows = await ctx.db.query<{ n: number | null }>(
        `select max(nullif(regexp_replace(data->>'number', '\\D', '', 'g'), '')::int) as n
         from records where company_id = $1 and type = 'invoice'`,
        [ctx.companyId],
    )
    return `${prefix}${String((rows[0]?.n ?? 0) + 1).padStart(4, '0')}`
}

export async function draftInvoice(
    ctx: Ctx,
    p: { projectId: string; amountCents: number; description: string; phaseId?: string },
): Promise<StoredRecord>
{
    if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) throw new ValidationError(['The amount must be more than zero'])
    const project = await ctx.records.getRaw(p.projectId)
    const number = await nextInvoiceNumber(ctx)
    const issued = today(ctx)
    return ctx.records.create({
        type: 'invoice',
        title: `${number} · ${project.title}`,
        status: 'Draft',
        parentId: project.id,
        data: {
            number,
            client: project.data.client,
            project: project.id,
            ...(p.phaseId ? { phase: p.phaseId } : {}),
            amount: p.amountCents,
            paid: 0,
            issued,
            due: addDays(issued, ctx.config.paymentTermsDays ?? 14),
            lines: p.description,
        },
    })
}

async function recordPayment(ctx: Ctx, invoiceId: string, amountCents: number, date: string, bankLineId?: string): Promise<StoredRecord>
{
    const inv = await ctx.records.getRaw(invoiceId)
    const payment = await ctx.records.create({
        type: 'payment',
        title: `Payment on ${inv.data.number ?? inv.title}`,
        parentId: inv.id,
        data: { invoice: inv.id, amount: amountCents, date, ...(bankLineId ? { bankLine: bankLineId } : {}) },
    })
    const paid = Number(inv.data.paid ?? 0) + amountCents
    const status = paid >= Number(inv.data.amount ?? 0) ? 'Paid' : 'Part paid'
    await ctx.records.update(inv.id, { status, data: { paid } })
    return payment
}

async function clientEmail(ctx: Ctx, inv: StoredRecord): Promise<{ name: string; email: string | null }>
{
    if (!inv.data.client) return { name: 'there', email: null }
    const client = await ctx.records.getRaw(String(inv.data.client))
    return { name: String(client.data.contact ?? client.title), email: client.data.email ? String(client.data.email) : null }
}

function reminderText(inv: StoredRecord, name: string, days: number, company: string): string
{
    return [
        `Hi ${name},`,
        '',
        `A quick reminder that invoice ${inv.data.number} for ${formatMoney(amountDue(inv))} was due on ${inv.data.due}` +
            (days > 0 ? `, ${days} day${days === 1 ? '' : 's'} ago.` : '.'),
        'If it has already been paid, thank you, and please ignore this note.',
        '',
        'Kind regards,',
        company,
    ].join('\n')
}

/**
 * Money: quotes, invoices, payments, expense claims and the bank feed.
 * A finished phase drafts its share of the project value as an invoice;
 * anything that leaves the company (an invoice, a reminder, a refund)
 * waits for a manager's approval.
 */
export default defineModule({
    id: 'money',
    name: 'Money',
    description: 'Quotes, invoices, payments, expense claims and bank lines.',
    dependsOn: ['projects'],
    records: [
        {
            type: 'quote',
            label: 'Quote',
            plural: 'Quotes',
            parent: 'client',
            visibility: 'managers',
            statuses: ['Draft', 'Sent', 'Accepted', 'Declined'],
            fields: [
                { key: 'client', label: 'Client', kind: 'record', recordType: 'client', required: true },
                { key: 'amount', label: 'Amount', kind: 'money', required: true },
                { key: 'projectType', label: 'Project type', kind: 'text' },
                { key: 'validUntil', label: 'Valid until', kind: 'date' },
                { key: 'lines', label: 'Scope', kind: 'longtext' },
            ],
        },
        {
            type: 'invoice',
            label: 'Invoice',
            plural: 'Invoices',
            parent: 'project',
            visibility: 'managers',
            statuses: ['Draft', 'Sent', 'Part paid', 'Paid', 'Void'],
            fields: [
                { key: 'number', label: 'Number', kind: 'text', required: true },
                { key: 'client', label: 'Client', kind: 'record', recordType: 'client' },
                { key: 'project', label: 'Project', kind: 'record', recordType: 'project' },
                { key: 'phase', label: 'Phase', kind: 'record', recordType: 'phase' },
                { key: 'amount', label: 'Amount', kind: 'money', required: true },
                { key: 'paid', label: 'Paid so far', kind: 'money' },
                { key: 'issued', label: 'Issued', kind: 'date' },
                { key: 'due', label: 'Due', kind: 'date' },
                { key: 'lines', label: 'Description', kind: 'longtext' },
                { key: 'lastReminder', label: 'Last reminder', kind: 'date' },
            ],
        },
        {
            type: 'payment',
            label: 'Payment',
            plural: 'Payments',
            parent: 'invoice',
            visibility: 'managers',
            statuses: ['Received'],
            fields: [
                { key: 'invoice', label: 'Invoice', kind: 'record', recordType: 'invoice', required: true },
                { key: 'amount', label: 'Amount', kind: 'money', required: true },
                { key: 'date', label: 'Date', kind: 'date', required: true },
                { key: 'bankLine', label: 'Bank line', kind: 'record', recordType: 'bank_line' },
            ],
        },
        {
            type: 'expense',
            label: 'Expense claim',
            plural: 'Expense claims',
            visibility: 'assigned',
            assigneeField: 'claimant',
            statuses: ['Submitted', 'Approved', 'Rejected', 'Reimbursed'],
            fields: [
                { key: 'claimant', label: 'Claimed by', kind: 'user' },
                { key: 'amount', label: 'Amount', kind: 'money', required: true },
                { key: 'date', label: 'Date', kind: 'date', required: true },
                { key: 'category', label: 'Category', kind: 'select', options: ['Travel', 'Software', 'Hardware', 'Meals', 'Data and airtime', 'Other'] },
                { key: 'project', label: 'Project', kind: 'record', recordType: 'project' },
                { key: 'slip', label: 'Slip photo', kind: 'url' },
                { key: 'notes', label: 'Notes', kind: 'longtext' },
            ],
        },
        {
            type: 'bank_line',
            label: 'Bank line',
            plural: 'Bank lines',
            visibility: 'managers',
            statuses: ['Unmatched', 'Matched', 'Ignored'],
            fields: [
                { key: 'date', label: 'Date', kind: 'date', required: true },
                { key: 'amount', label: 'Amount', kind: 'money', required: true },
                { key: 'balance', label: 'Balance after', kind: 'money' },
                { key: 'account', label: 'Account', kind: 'text' },
                { key: 'reference', label: 'Reference', kind: 'text' },
                { key: 'category', label: 'Category', kind: 'text' },
                { key: 'fingerprint', label: 'Fingerprint', kind: 'text' },
                { key: 'matchedTo', label: 'Matched to', kind: 'record' },
            ],
        },
    ],
    emits: ['invoice.created', 'invoice.sent', 'invoice.paid', 'invoice.overdue', 'expense.created', 'bank_line.created', 'payment.created'],
    listens: {
        // A finished phase bills its share of the project value.
        'phase.done': async (ctx, event) => {
            const phase = event.payload.record as StoredRecord
            if (!phase.parentId) return
            const project = await ctx.records.getRaw(phase.parentId)
            const type = ctx.config.projectTypes.find((t) => t.id === project.data.projectType)
            const value = Number(project.data.value ?? 0)
            if (!type || type.billing !== 'phased' || value <= 0) return
            const existing = await ctx.records.list('invoice', { parentId: project.id, where: { phase: phase.id } })
            if (existing.length > 0) return
            const phases = (await ctx.records.list('phase', { parentId: project.id })).sort((a, b) => Number(a.data.order) - Number(b.data.order))
            const parts = splitByShares(value, phases.map((p) => Number(p.data.share ?? 0)))
            const amount = parts[phases.findIndex((p) => p.id === phase.id)] ?? 0
            if (amount <= 0) return
            const share = Math.round(Number(phase.data.share ?? 0) * 100)
            await draftInvoice(ctx, {
                projectId: project.id,
                phaseId: phase.id,
                amountCents: amount,
                description: `${project.title}: ${phase.title} (${share}% of the project)`,
            })
        },
    },
    actions: [
        {
            name: 'invoice.draft',
            label: 'Draft an invoice',
            description: 'Creates a draft invoice on a project. Nothing is sent.',
            managersOnly: true,
            needsApproval: false,
            params: {
                projectId: { type: 'string', description: 'Project record id', required: true },
                amountCents: { type: 'number', description: 'Amount in cents', required: true },
                description: { type: 'string', description: 'What the invoice is for', required: true },
            },
            async run(ctx, p) {
                const inv = await draftInvoice(ctx, { projectId: String(p.projectId), amountCents: Number(p.amountCents), description: String(p.description) })
                return { invoiceId: inv.id, number: inv.data.number }
            },
        },
        {
            name: 'invoice.send',
            label: 'Send an invoice',
            description: 'Emails an invoice to the client and marks it sent.',
            managersOnly: true,
            needsApproval: true,
            params: { invoiceId: { type: 'string', description: 'Invoice record id', required: true } },
            async run(ctx, p) {
                const inv = await ctx.records.getRaw(String(p.invoiceId))
                if (inv.status !== 'Draft') throw new ValidationError([`${inv.data.number} is already ${inv.status.toLowerCase()}`])
                const { name, email } = await clientEmail(ctx, inv)
                const mail = ctx.services.mail as MailService | undefined
                let sentTo: string | null = null
                if (mail && email) {
                    await mail.send({
                        to: email,
                        subject: `Invoice ${inv.data.number} from ${ctx.config.theme.name}`,
                        text: `Hi ${name},\n\nPlease find invoice ${inv.data.number} for ${formatMoney(Number(inv.data.amount))}, due ${inv.data.due}.\n\n${inv.data.lines ?? ''}\n\nKind regards,\n${ctx.config.theme.name}`,
                    })
                    sentTo = email
                }
                const issued = today(ctx)
                await ctx.records.update(inv.id, {
                    status: 'Sent',
                    data: { issued, due: addDays(issued, ctx.config.paymentTermsDays ?? 14) },
                })
                return { invoiceId: inv.id, sentTo }
            },
        },
        {
            name: 'invoice.send_reminder',
            label: 'Send a payment reminder',
            description: 'Emails the client a reminder about an unpaid invoice. The agent may write the message.',
            managersOnly: true,
            needsApproval: true,
            params: {
                invoiceId: { type: 'string', description: 'Invoice record id', required: true },
                message: { type: 'string', description: 'The reminder text. Left out, a polite default is used.' },
            },
            async run(ctx, p) {
                const inv = await ctx.records.getRaw(String(p.invoiceId))
                if (!OPEN_INVOICE.includes(inv.status)) return { skipped: `${inv.data.number} is ${inv.status.toLowerCase()}` }
                const { name, email } = await clientEmail(ctx, inv)
                const days = inv.data.due ? daysBetween(String(inv.data.due), ctx.now()) : 0
                const text = p.message ? String(p.message) : reminderText(inv, name, days, ctx.config.theme.name)
                const mail = ctx.services.mail as MailService | undefined
                if (mail && email) await mail.send({ to: email, subject: `Reminder: invoice ${inv.data.number}`, text })
                await ctx.records.update(inv.id, { data: { lastReminder: today(ctx) } })
                return { invoiceId: inv.id, sentTo: mail && email ? email : null, text }
            },
        },
        {
            name: 'invoice.record_payment',
            label: 'Record a payment',
            description: 'Records money received against an invoice.',
            managersOnly: true,
            needsApproval: false,
            params: {
                invoiceId: { type: 'string', description: 'Invoice record id', required: true },
                amountCents: { type: 'number', description: 'Amount in cents', required: true },
                date: { type: 'string', description: 'Date received, YYYY-MM-DD' },
            },
            async run(ctx, p) {
                const pay = await recordPayment(ctx, String(p.invoiceId), Number(p.amountCents), p.date ? String(p.date) : today(ctx))
                return { paymentId: pay.id }
            },
        },
        {
            name: 'invoice.check_overdue',
            label: 'Check for overdue invoices',
            description: 'Finds unpaid invoices past their due date and raises invoice.overdue for each.',
            needsApproval: false,
            params: {},
            async run(ctx) {
                const open = await ctx.records.list('invoice', { status: OPEN_INVOICE })
                const overdue = []
                for (const inv of open) {
                    if (!inv.data.due) continue
                    const days = daysBetween(String(inv.data.due), ctx.now())
                    if (days <= 0) continue
                    overdue.push({ invoiceId: inv.id, number: inv.data.number, daysOverdue: days })
                    await ctx.events.emit('invoice.overdue', {
                        recordId: inv.id,
                        payload: { record: inv, invoiceId: inv.id, daysOverdue: days, amountDue: amountDue(inv) },
                    })
                }
                return { overdue }
            },
        },
        {
            name: 'expense.decide',
            label: 'Approve or reject an expense claim',
            description: 'Approves or rejects a claim an employee submitted.',
            managersOnly: true,
            needsApproval: false,
            params: {
                expenseId: { type: 'string', description: 'Expense record id', required: true },
                approve: { type: 'boolean', description: 'true to approve, false to reject', required: true },
            },
            async run(ctx, p) {
                const exp = await ctx.records.setStatus(String(p.expenseId), p.approve ? 'Approved' : 'Rejected')
                return { expenseId: exp.id, status: exp.status }
            },
        },
        {
            name: 'bank.import_csv',
            label: 'Import a bank statement',
            description: 'Adds lines from a bank CSV export, skipping any already imported.',
            managersOnly: true,
            needsApproval: false,
            params: {
                csv: { type: 'string', description: 'The CSV file contents', required: true },
                account: { type: 'string', description: 'Account name, e.g. "FNB cheque"' },
            },
            async run(ctx, p) {
                const lines = parseBankCsv(String(p.csv))
                const account = p.account ? String(p.account) : 'Main account'
                let added = 0
                let skipped = 0
                for (const line of lines) {
                    const seen = await ctx.records.list('bank_line', { where: { fingerprint: line.fingerprint }, limit: 1 })
                    if (seen.length > 0) {
                        skipped++
                        continue
                    }
                    await ctx.records.create({
                        type: 'bank_line',
                        title: line.description || '(no description)',
                        data: {
                            date: line.date,
                            amount: line.amount,
                            ...(line.balance === null ? {} : { balance: line.balance }),
                            account,
                            ...(line.reference ? { reference: line.reference } : {}),
                            fingerprint: line.fingerprint,
                        },
                    })
                    added++
                }
                return { added, skipped }
            },
        },
        {
            name: 'bank.auto_match',
            label: 'Match bank lines to invoices',
            description: 'Matches money received to open invoices by invoice number, or by an exact unique amount.',
            managersOnly: true,
            needsApproval: false,
            params: {},
            async run(ctx) {
                const lines = (await ctx.records.list('bank_line', { status: 'Unmatched' })).filter((l) => Number(l.data.amount) > 0)
                const matched: { bankLineId: string; invoiceId: string; how: string }[] = []
                for (const line of lines) {
                    const open = await ctx.records.list('invoice', { status: OPEN_INVOICE })
                    const text = `${line.title} ${line.data.reference ?? ''}`.toUpperCase()
                    const amount = Number(line.data.amount)
                    let inv = open.find((i) => i.data.number && text.includes(String(i.data.number).toUpperCase()))
                    let how = 'invoice number'
                    if (!inv) {
                        const same = open.filter((i) => amountDue(i) === amount)
                        if (same.length === 1) {
                            inv = same[0]
                            how = 'exact amount'
                        }
                    }
                    if (!inv) continue
                    await recordPayment(ctx, inv.id, Math.min(amount, amountDue(inv)), String(line.data.date), line.id)
                    await ctx.records.update(line.id, { status: 'Matched', data: { matchedTo: inv.id } })
                    matched.push({ bankLineId: line.id, invoiceId: inv.id, how })
                }
                return { matched }
            },
        },
    ],
    tiles: [
        { id: 'money.cash', title: 'Cash in the bank', sides: ['manage'], size: 'sm', load: cashTile },
        { id: 'money.owed', title: 'Owed to you', sides: ['manage'], size: 'md', load: owedTile },
        { id: 'money.month', title: 'This month', sides: ['manage'], size: 'sm', load: monthTile },
        { id: 'money.runway', title: 'Runway', sides: ['manage'], size: 'sm', load: runwayTile },
        {
            id: 'money.my_claims',
            title: 'My expense claims',
            sides: ['employee'],
            size: 'md',
            async load(ctx) {
                const claims = await ctx.records.list('expense', { where: { claimant: ctx.actor.id }, limit: 20 })
                const waiting = claims.filter((c) => c.status === 'Submitted' || c.status === 'Approved')
                return {
                    value: formatMoney(waiting.reduce((s, c) => s + Number(c.data.amount ?? 0), 0)),
                    caption: 'waiting to be paid back',
                    items: claims.slice(0, 6).map((c) => ({ label: c.title, detail: `${formatMoney(Number(c.data.amount))} · ${c.status}`, href: `/records/${c.id}` })),
                }
            },
        },
    ],
})

/** The latest known balance per account, from the bank feed. */
export async function cashOnHand(ctx: Ctx): Promise<{ total: number; asOf: string | null; accounts: { account: string; balance: number }[] }>
{
    const rows = await ctx.db.query<{ account: string; balance: string; date: string }>(
        `select distinct on (data->>'account') data->>'account' as account, data->>'balance' as balance, data->>'date' as date
         from records where company_id = $1 and type = 'bank_line' and data ? 'balance'
         order by data->>'account', data->>'date' desc, created_at desc`,
        [ctx.companyId],
    )
    const accounts = rows.map((r) => ({ account: r.account, balance: Number(r.balance) }))
    const asOf = rows.map((r) => r.date).sort().at(-1) ?? null
    return { total: accounts.reduce((s, a) => s + a.balance, 0), asOf, accounts }
}

/** Money in and out of the bank between two dates (inclusive). */
export async function flows(ctx: Ctx, from: string, to: string): Promise<{ moneyIn: number; moneyOut: number }>
{
    const rows = await ctx.db.query<{ money_in: string | null; money_out: string | null }>(
        `select sum(greatest((data->>'amount')::bigint, 0)) as money_in,
                sum(least((data->>'amount')::bigint, 0)) as money_out
         from records where company_id = $1 and type = 'bank_line' and status <> 'Ignored'
           and data->>'date' >= $2 and data->>'date' <= $3`,
        [ctx.companyId, from, to],
    )
    return { moneyIn: Number(rows[0]?.money_in ?? 0), moneyOut: -Number(rows[0]?.money_out ?? 0) }
}

async function cashTile(ctx: Ctx): Promise<TileData>
{
    const cash = await cashOnHand(ctx)
    if (!cash.asOf) return { value: '—', caption: 'Import a bank statement to see cash', tone: 'neutral' }
    return {
        value: formatMoney(cash.total, ctx.config.currency),
        caption: `as of ${cash.asOf}`,
        tone: cash.total > 0 ? 'good' : 'critical',
        items: cash.accounts.map((a) => ({ label: a.account, detail: formatMoney(a.balance, ctx.config.currency) })),
    }
}

async function owedTile(ctx: Ctx): Promise<TileData>
{
    const open = await ctx.records.list('invoice', { status: OPEN_INVOICE })
    const t = today(ctx)
    const overdue = open.filter((i) => i.data.due && String(i.data.due) < t)
    const total = open.reduce((s, i) => s + amountDue(i), 0)
    return {
        value: formatMoney(total, ctx.config.currency),
        caption: overdue.length ? `${overdue.length} overdue` : `${open.length} unpaid invoice${open.length === 1 ? '' : 's'}`,
        tone: overdue.length ? 'warning' : 'neutral',
        items: open
            .sort((a, b) => String(a.data.due).localeCompare(String(b.data.due)))
            .slice(0, 6)
            .map((i) => {
                const days = i.data.due ? daysBetween(String(i.data.due), ctx.now()) : 0
                return {
                    label: String(i.data.number),
                    detail: `${formatMoney(amountDue(i), ctx.config.currency)} · ${days > 0 ? `${days} days late` : `due ${i.data.due}`}`,
                    href: `/records/${i.id}`,
                    tone: (days > 14 ? 'critical' : days > 0 ? 'warning' : 'neutral') as TileData['tone'],
                }
            }),
    }
}

async function monthTile(ctx: Ctx): Promise<TileData>
{
    const t = today(ctx)
    const { moneyIn, moneyOut } = await flows(ctx, `${t.slice(0, 7)}-01`, t)
    const net = moneyIn - moneyOut
    return {
        value: formatMoney(net, ctx.config.currency),
        caption: `${formatMoney(moneyIn, ctx.config.currency)} in, ${formatMoney(moneyOut, ctx.config.currency)} out`,
        tone: net >= 0 ? 'good' : 'warning',
    }
}

async function runwayTile(ctx: Ctx): Promise<TileData>
{
    const cash = await cashOnHand(ctx)
    const t = today(ctx)
    const from = new Date(ctx.now())
    from.setUTCDate(from.getUTCDate() - 90)
    const { moneyOut } = await flows(ctx, from.toISOString().slice(0, 10), t)
    const monthly = moneyOut / 3
    if (!cash.asOf || monthly <= 0) return { value: '—', caption: 'Needs 90 days of bank lines', tone: 'neutral' }
    const months = cash.total / monthly
    return {
        value: `${months.toFixed(1)} months`,
        caption: `at ${formatMoney(Math.round(monthly), ctx.config.currency)} a month going out`,
        tone: months < 2 ? 'critical' : months < 4 ? 'warning' : 'good',
    }
}
