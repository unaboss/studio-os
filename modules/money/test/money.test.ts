import { describe, expect, it } from 'vitest'
import { AGENT } from '@studio-os/core'
import projects from '@studio-os/module-projects'
import money, { parseBankCsv, type MailService } from '@studio-os/module-money'
import { testStudio } from '@studio-os/testing'

async function setup()
{
    const s = await testStudio([projects, money])
    const sent: { to: string; subject: string; text: string }[] = []
    const mail: MailService = { async send(msg) { sent.push(msg); return { id: String(sent.length) } } }
    s.services.mail = mail
    const m = s.as(s.manager)
    const client = await m.records.create({ type: 'client', title: 'Karoo Coffee', data: { contact: 'Anele', email: 'anele@karoo.example' } })
    const started = await m.actions.request('project.start', { clientId: client.id, title: 'Ordering app', projectType: 'build', valueCents: 10_000_000 })
    if (started.status !== 'done') throw new Error('expected done')
    return { s, m, sent, client, projectId: String(started.result.projectId), phaseIds: started.result.phaseIds as string[] }
}

describe('phased invoicing', () => {
    it('drafts the phase share as an invoice when a phase is done', async () => {
        const { m, projectId, phaseIds } = await setup()
        await m.actions.request('phase.complete', { phaseId: phaseIds[0]! })
        const invoices = await m.records.list('invoice', { parentId: projectId })
        expect(invoices).toHaveLength(1)
        expect(invoices[0]!.status).toBe('Draft')
        expect(invoices[0]!.data.amount).toBe(4_000_000)
        expect(invoices[0]!.data.number).toBe('INV-0001')
        await m.actions.request('phase.complete', { phaseId: phaseIds[0]! })
        expect(await m.records.list('invoice', { parentId: projectId })).toHaveLength(1)
    })

    it('closes a phase, and bills it, when its last task is done', async () => {
        const { s, m, projectId, phaseIds } = await setup()
        const e = s.as(s.employee)
        const task = await m.records.create({ type: 'task', title: 'Wireframes', parentId: projectId, data: { phase: phaseIds[0]!, assignee: s.employee.id } })
        await m.records.update(projectId, { data: { members: [s.manager.id, s.employee.id] } })
        await e.actions.request('task.move', { taskId: task.id, status: 'Done' })
        const phase = await m.records.get(phaseIds[0]!)
        expect(phase.status).toBe('Done')
        expect(await m.records.list('invoice', { parentId: projectId })).toHaveLength(1)
    })

    it('waits for approval before the agent sends an invoice', async () => {
        const { s, m, sent, phaseIds } = await setup()
        await m.actions.request('phase.complete', { phaseId: phaseIds[0]! })
        const [inv] = await m.records.list('invoice')
        const agent = s.as(AGENT)
        const out = await agent.actions.request('invoice.send', { invoiceId: inv!.id }, { via: 'agent', automated: true })
        expect(out.status).toBe('pending')
        expect(sent).toHaveLength(0)
        const [approval] = await m.actions.pending()
        await m.actions.decide(approval!.id, true)
        expect(sent).toHaveLength(1)
        expect(sent[0]!.to).toBe('anele@karoo.example')
        expect((await m.records.get(inv!.id)).status).toBe('Sent')
    })
})

const FNB = `"2","Account","62000000000","Gold Business Account"
"3","Statement Date","2026/11/03"
Date,Amount,Balance,Description
2026/10/28,-1500.00,52000.00,"VULTR.COM CLOUD"
2026/10/30,40000.00,92000.00,"KAROO COFFEE INV-0001"
2026/10/31,-50.00,91950.00,"AIRTIME"
2026/10/31,-50.00,91900.00,"AIRTIME"
`

describe('bank feed', () => {
    it('reads FNB, Capitec and Standard Bank exports', () => {
        const fnb = parseBankCsv(FNB)
        expect(fnb).toHaveLength(4)
        expect(fnb[1]).toMatchObject({ date: '2026-10-30', amount: 4_000_000, balance: 9_200_000 })
        expect(new Set(fnb.map((l) => l.fingerprint)).size).toBe(4)

        const capitec = parseBankCsv(`Nr,Account,Posting Date,Transaction Date,Description,Original Description,Parent Category,Category,Money In,Money Out,Fee,Balance
1,1234,02/11/2026,01/11/2026,Takealot,TAKEALOT,Shopping,Online,,-899.00,,10101.00
2,1234,02/11/2026,02/11/2026,Client pay,PAYMENT,Income,Other,2500.00,,-2.50,12598.50`)
        expect(capitec.map((l) => l.amount)).toEqual([-89_900, 249_750])
        expect(capitec[0]!.date).toBe('2026-11-01')

        const sb = parseBankCsv(`ACC-NO,123\nHIST,20261101,,-120.50,UBER TRIP,JHB\nHIST,20261102,,3000.00,DEPOSIT,`)
        expect(sb).toHaveLength(2)
        expect(sb[0]).toMatchObject({ date: '2026-11-01', amount: -12_050, description: 'UBER TRIP JHB' })
    })

    it('refuses a statement it cannot read instead of guessing', () => {
        expect(() => parseBankCsv('foo,bar\n1,2')).toThrow('recognises')
    })

    it('imports once, matches payments to invoices and shows cash', async () => {
        const { m, phaseIds } = await setup()
        await m.actions.request('phase.complete', { phaseId: phaseIds[0]! })
        const [inv] = await m.records.list('invoice')
        await m.actions.request('invoice.send', { invoiceId: inv!.id })
        const first = await m.actions.request('bank.import_csv', { csv: FNB, account: 'FNB business' })
        expect(first).toMatchObject({ status: 'done', result: { added: 4, skipped: 0 } })
        const again = await m.actions.request('bank.import_csv', { csv: FNB, account: 'FNB business' })
        expect(again).toMatchObject({ result: { added: 0, skipped: 4 } })

        const matched = await m.actions.request('bank.auto_match', {})
        expect(matched).toMatchObject({ result: { matched: [{ invoiceId: inv!.id, how: 'invoice number' }] } })
        expect((await m.records.get(inv!.id)).status).toBe('Paid')

        const tile = await m.registry.tiles('manage').find((t) => t.id === 'money.cash')!.load(m)
        expect(tile.value).toBe('R91 900.00')
    })
})

describe('overdue invoices', () => {
    it('raises invoice.overdue, and a rule queues a reminder for approval', async () => {
        const { s, m, sent, phaseIds } = await setup()
        await s.db.query(
            `insert into automations (id, company_id, name, when_event, conditions, action, params)
             values ('auto_chase', $1, 'Chase at 7 days', 'invoice.overdue', $2::jsonb, 'invoice.send_reminder', $3::jsonb)`,
            [s.companyId, JSON.stringify([{ path: 'payload.daysOverdue', op: 'gte', value: 7 }]), JSON.stringify({ invoiceId: '{{payload.invoiceId}}' })],
        )
        await m.actions.request('phase.complete', { phaseId: phaseIds[0]! })
        const [inv] = await m.records.list('invoice')
        await m.actions.request('invoice.send', { invoiceId: inv!.id })
        sent.length = 0

        s.clock = new Date('2026-11-20T08:00:00Z')
        const sys = s.system
        await sys.actions.request('invoice.check_overdue', {})
        expect(await m.actions.pending()).toHaveLength(0)

        s.clock = new Date('2026-11-24T08:00:00Z')
        await s.system.actions.request('invoice.check_overdue', {})
        const pending = await m.actions.pending()
        expect(pending).toHaveLength(1)
        expect(pending[0]!.action).toBe('invoice.send_reminder')
        expect(sent).toHaveLength(0)
        await m.actions.decide(pending[0]!.id, true)
        expect(sent[0]!.text).toContain('7 days ago')
    })
})
