import { describe, expect, it } from 'vitest'
import projects from '@studio-os/module-projects'
import compliance, { addMonths, deadlinesFor } from '@studio-os/module-compliance'
import { done, testStudio } from '@studio-os/testing'

describe('deadlines', () => {
    it('puts EMP201 on the 7th, or the Friday before a weekend', () => {
        const list = deadlinesFor(new Date('2026-11-03T00:00:00Z'), { yearEndMonth: 2 })
        const emp = list.filter((d) => d.kind === 'EMP201')
        expect(emp[0]).toMatchObject({ period: '2026-10', due: '2026-11-06' })
        expect(emp.find((d) => d.period === '2026-11')!.due).toBe('2026-12-07')
        expect(emp.length).toBe(12)
    })

    it('adds provisional tax, the company return, VAT and CIPC from settings', () => {
        const list = deadlinesFor(new Date('2026-11-03T00:00:00Z'), { yearEndMonth: 2, vatRegistered: true, vatPeriods: 'odd', incorporated: '2023-03-15' })
        const irp6 = list.filter((d) => d.kind === 'IRP6').map((d) => d.due)
        expect(irp6).toEqual(['2027-02-26', '2027-08-31'])
        expect(list.find((d) => d.kind === 'ITR14')!.due).toBe('2027-02-26')
        expect(list.filter((d) => d.kind === 'VAT201')[0]).toMatchObject({ period: '2026-11', due: '2026-12-31' })
        expect(list.find((d) => d.kind === 'CIPC annual return')!.due).toBe('2027-04-26')
    })

    it('adds a month without running off the end', () => {
        expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    })

    it('seeds once, flags overdue ones, and rolls repeating ones on', async () => {
        const s = await testStudio([projects, compliance])
        const m = s.as(s.manager)
        const first = await m.actions.request('compliance.seed', {})
        const again = await m.actions.request('compliance.seed', {})
        expect(first).toMatchObject({ result: { added: expect.any(Number) } })
        expect(again).toMatchObject({ result: { added: 0 } })
        s.clock = new Date('2026-11-09T08:00:00Z')
        const checked = await s.system.actions.request('compliance.check', {})
        expect(done(checked).overdue).toHaveLength(1)
        const vat = await m.records.create({ type: 'obligation', title: 'VAT201', data: { kind: 'VAT201', due: '2026-11-30', recurs: 'Every two months' } })
        const nextId = done(await m.actions.request('compliance.done', { obligationId: vat.id })).nextId
        expect((await m.records.get(nextId)).data.due).toBe('2027-01-30')
    })
})
