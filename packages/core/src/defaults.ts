import type { CompanyConfig } from './types.ts'

/**
 * A sensible starting point for a small South African software studio.
 * Everything here is editable in Settings.
 */
export const DEFAULT_CONFIG: CompanyConfig = {
    currency: 'ZAR',
    modules: ['projects', 'money', 'people', 'sales', 'compliance', 'github'],
    fields: {},
    statuses: {},
    projectTypes: [
        {
            id: 'build',
            name: 'Software build (40/30/30)',
            billing: 'phased',
            phases: [
                { name: 'Discovery and design', share: 0.4 },
                { name: 'Build', share: 0.3 },
                { name: 'Launch and handover', share: 0.3 },
            ],
        },
        {
            id: 'small',
            name: 'Small job (50/50)',
            billing: 'phased',
            phases: [
                { name: 'Deposit and build', share: 0.5 },
                { name: 'Delivery', share: 0.5 },
            ],
        },
        { id: 'retainer', name: 'Monthly retainer', billing: 'retainer', phases: [] },
        { id: 'hourly', name: 'Hourly support', billing: 'hourly', phases: [] },
    ],
    layouts: {
        manage: ['money.cash', 'money.owed', 'money.month', 'money.runway', 'projects.health', 'compliance.next', 'sales.pipeline', 'people.team_week', 'github.activity', 'people.payroll', 'people.whos_out'],
        employee: ['projects.my_tasks', 'github.my_reviews', 'people.my_week', 'money.my_claims', 'people.my_leave', 'people.whos_out'],
    },
    theme: { accent: '#0f766e', name: 'My Studio' },
    paymentTermsDays: 14,
    settings: {},
}
