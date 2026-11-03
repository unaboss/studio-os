import { describe, expect, it } from 'vitest'
import projects from '@studio-os/module-projects'
import people, { payslipFor, workingDays } from '@studio-os/module-people'
import { testStudio } from '@studio-os/testing'

describe('payroll', () => {
    it('works out PAYE and UIF on the 2027 SARS table', () => {
        const slip = payslipFor(3_000_000)
        expect(slip.paye).toBe(468_100)
        expect(slip.uif).toBe(17_712)
        expect(slip.net).toBe(3_000_000 - 468_100 - 17_712)
    })

    it('charges no PAYE under the tax threshold', () => {
        expect(payslipFor(800_000).paye).toBe(0)
    })

    it('drafts payslips that only the staff member and managers can see', async () => {
        const s = await testStudio([projects, people])
        const m = s.as(s.manager)
        await m.records.create({ type: 'person', title: 'Lerato', data: { user: s.employee.id, salary: 2_500_000 } })
        await m.records.create({ type: 'person', title: 'Thabo', data: { user: s.manager.id, salary: 4_000_000 } })
        const out = await m.actions.request('payroll.draft_month', { month: '2026-11' })
        expect(out).toMatchObject({ result: { created: [expect.any(String), expect.any(String)] } })
        const e = s.as(s.employee)
        const mine = await e.records.list('payslip')
        expect(mine).toHaveLength(1)
        expect(mine[0]!.data.gross).toBe(2_500_000)
        expect(mine[0]!.data.sdl).toBeUndefined()
        const staff = await e.records.list('person')
        expect(staff.every((p) => p.data.salary === undefined)).toBe(true)
    })
})

describe('leave and time', () => {
    it('counts working days on a leave request', async () => {
        expect(workingDays('2026-11-06', '2026-11-10')).toBe(3)
        const s = await testStudio([projects, people])
        const e = s.as(s.employee)
        const leave = await e.records.create({ type: 'leave', title: 'Away', data: { user: s.employee.id, kind: 'Annual', from: '2026-11-06', to: '2026-11-10' } })
        expect((await e.records.get(leave.id)).data.days).toBe(3)
    })

    it('lets people confirm only their own suggested time', async () => {
        const s = await testStudio([projects, people])
        const m = s.as(s.manager)
        const entry = await m.records.create({ type: 'time', title: 'Suggested', status: 'Suggested', data: { user: s.manager.id, date: '2026-11-03', hours: 3, source: 'GitHub' } })
        const e = s.as(s.employee)
        await expect(e.actions.request('time.confirm', { timeId: entry.id })).rejects.toThrow()
        const done = await m.actions.request('time.confirm', { timeId: entry.id, hours: 2.5 })
        expect(done).toMatchObject({ result: { hours: 2.5 } })
    })
})
