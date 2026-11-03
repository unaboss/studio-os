import { describe, expect, it } from 'vitest'
import projects from '@studio-os/module-projects'
import { testStudio } from '@studio-os/testing'
import { ConfigError, defineModule, ForbiddenError, formatMoney, Registry, splitByShares, ValidationError, DEFAULT_CONFIG } from '@studio-os/core'

async function withClient()
{
    const s = await testStudio([projects])
    const m = s.as(s.manager)
    const client = await m.records.create({ type: 'client', title: 'Karoo Coffee', data: { email: 'ops@karoo.example' } })
    return { s, m, client }
}

describe('money helpers', () => {
    it('formats rand with spaces', () => {
        expect(formatMoney(4_310_000)).toBe('R43 100.00')
        expect(formatMoney(-150)).toBe('-R1.50')
    })

    it('splits by shares without losing a cent', () => {
        const parts = splitByShares(10_000_001, [0.4, 0.3, 0.3])
        expect(parts.reduce((a, b) => a + b, 0)).toBe(10_000_001)
        expect(parts[0]).toBe(4_000_000)
    })
})

describe('records', () => {
    it('validates fields and rejects unknown keys', async () => {
        const { m } = await withClient()
        await expect(m.records.create({ type: 'client', title: 'X', data: { nope: 1 } })).rejects.toBeInstanceOf(ValidationError)
        await expect(m.records.create({ type: 'client', title: ' ' })).rejects.toBeInstanceOf(ValidationError)
    })

    it('adds custom fields from config, and they validate', async () => {
        const s = await testStudio([projects], { fields: { client: [{ key: 'vatNumber', label: 'VAT number', kind: 'text', required: true }] } })
        const m = s.as(s.manager)
        await expect(m.records.create({ type: 'client', title: 'No VAT' })).rejects.toThrow('VAT number is required')
        const ok = await m.records.create({ type: 'client', title: 'Has VAT', data: { vatNumber: '4123456789' } })
        expect(ok.data.vatNumber).toBe('4123456789')
    })

    it('lets a company rename statuses', async () => {
        const s = await testStudio([projects], { statuses: { task: ['Backlog', 'Doing', 'Shipped'] } })
        const m = s.as(s.manager)
        const c = await m.records.create({ type: 'client', title: 'C' })
        const p = await m.records.create({ type: 'project', title: 'P', parentId: c.id, data: { client: c.id, projectType: 'build' } })
        const t = await m.records.create({ type: 'task', title: 'T', parentId: p.id })
        expect(t.status).toBe('Backlog')
        await expect(m.records.setStatus(t.id, 'Done')).rejects.toBeInstanceOf(ValidationError)
    })

    it('hides projects an employee is not on, and hides sensitive fields', async () => {
        const { s, m, client } = await withClient()
        const mine = await m.records.create({ type: 'project', title: 'Mine', parentId: client.id, data: { client: client.id, projectType: 'build', value: 5_000_000, members: [s.employee.id] } })
        await m.records.create({ type: 'project', title: 'Not mine', parentId: client.id, data: { client: client.id, projectType: 'build', value: 9_000_000 } })
        const e = s.as(s.employee)
        const seen = await e.records.list('project')
        expect(seen.map((p) => p.title)).toEqual(['Mine'])
        expect(seen[0]!.data.value).toBeUndefined()
        await expect(e.records.update(mine.id, { data: { value: 1 } })).rejects.toBeInstanceOf(ForbiddenError)
    })

    it('emits created, updated and status events', async () => {
        const { m, client } = await withClient()
        await m.records.update(client.id, { status: 'Archived' })
        const names = m.events.log.map((e) => e.name)
        expect(names).toEqual(['client.created', 'client.updated', 'client.status_changed', 'client.archived'])
        const stored = await m.events.recent(10)
        expect(stored.map((e) => e.name)).toContain('client.created')
    })
})

describe('registry', () => {
    it('pulls in dependencies and refuses missing ones', () => {
        const a = defineModule({ id: 'a', name: 'A', description: '', records: [], emits: [], dependsOn: ['b'] })
        expect(() => new Registry([projects, a], { ...DEFAULT_CONFIG, modules: ['a'] })).toThrow(ConfigError)
    })

    it('orders tiles by the saved layout', () => {
        const r = new Registry([projects], { ...DEFAULT_CONFIG, modules: [], layouts: { manage: ['projects.my_tasks', 'projects.health'], employee: [] } })
        expect(r.tiles('manage').map((t) => t.id)).toEqual(['projects.my_tasks', 'projects.health'])
        expect(r.tiles('employee').map((t) => t.id)).toEqual(['projects.my_tasks'])
    })
})

describe('actions, approvals and automations', () => {
    const outbound = defineModule({
        id: 'outbound',
        name: 'Outbound',
        description: '',
        records: [],
        emits: ['ping.sent'],
        actions: [
            {
                name: 'ping.send',
                label: 'Send a ping',
                description: 'Pretends to message a client.',
                needsApproval: true,
                params: { to: { type: 'string', description: 'who', required: true } },
                async run(ctx, p) {
                    await ctx.events.emit('ping.sent', { payload: { to: p.to } })
                    return { sent: p.to }
                },
            },
        ],
    })

    it('runs straight away for a manager, queues for anyone else', async () => {
        const s = await testStudio([projects, outbound])
        const m = s.as(s.manager)
        expect(await m.actions.request('ping.send', { to: 'a' })).toEqual({ status: 'done', result: { sent: 'a' } })
        const e = s.as(s.employee)
        const queued = await e.actions.request('ping.send', { to: 'b' })
        expect(queued.status).toBe('pending')
        expect(await m.actions.pending()).toHaveLength(1)
        await expect(e.actions.decide((queued as { approvalId: string }).approvalId, true)).rejects.toBeInstanceOf(ForbiddenError)
        const decided = await m.actions.decide((queued as { approvalId: string }).approvalId, true)
        expect(decided.status).toBe('approved')
        expect(await m.actions.pending()).toHaveLength(0)
    })

    it('checks parameters', async () => {
        const s = await testStudio([projects, outbound])
        await expect(s.as(s.manager).actions.request('ping.send', {})).rejects.toThrow('to is required')
    })

    it('fires automation rules, which always need approval for outbound actions', async () => {
        const s = await testStudio([projects, outbound])
        await s.db.query(
            `insert into automations (id, company_id, name, when_event, conditions, action, params)
             values ('auto_1', $1, 'Ping new clients', 'client.created', $2::jsonb, 'ping.send', $3::jsonb)`,
            [s.companyId, JSON.stringify([{ path: 'payload.record.data.email', op: 'exists' }]), JSON.stringify({ to: '{{payload.record.data.email}}' })],
        )
        const m = s.as(s.manager)
        await m.records.create({ type: 'client', title: 'No email' })
        await m.records.create({ type: 'client', title: 'Email', data: { email: 'hi@example.com' } })
        const pending = await m.actions.pending()
        expect(pending).toHaveLength(1)
        expect(pending[0]!.params).toEqual({ to: 'hi@example.com' })
        expect(pending[0]!.requested_via).toBe('automation:auto_1')
    })
})
