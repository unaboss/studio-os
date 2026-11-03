/**
 * South African payroll basics, kept as data so a company can update the
 * tables each March in Settings without a code change.
 *
 * The default table is SARS's 2027 tax year (1 March 2026 to 28 February 2027),
 * from sars.gov.za/tax-rates/income-tax/rates-of-tax-for-individuals.
 * It covers PAYE on a plain monthly salary for someone under 65: no medical
 * credits, retirement fund deductions or fringe benefits. Payslips are drafts
 * until a manager checks and issues them.
 */
export interface Bracket
{
    /** Upper bound of annual taxable income in rand, or null for the top bracket. */
    readonly upTo: number | null
    /** Tax in rand on income up to the previous bracket's bound. */
    readonly base: number
    readonly rate: number
}

export interface PayrollSettings
{
    readonly taxTableName: string
    readonly brackets: readonly Bracket[]
    /** Primary rebate in rand a year. */
    readonly primaryRebate: number
    /** UIF: 1% each from employee and employer, on pay up to this ceiling (rand a month). */
    readonly uifCeiling: number
    readonly uifRate: number
    /** SDL is 1% of payroll, only once yearly payroll passes R500 000. */
    readonly sdlRegistered: boolean
    readonly sdlRate: number
    readonly payday: number
}

export const DEFAULT_PAYROLL: PayrollSettings = {
    taxTableName: 'SARS 2027 tax year (Mar 2026 to Feb 2027)',
    brackets: [
        { upTo: 245_100, base: 0, rate: 0.18 },
        { upTo: 383_100, base: 44_118, rate: 0.26 },
        { upTo: 530_200, base: 79_998, rate: 0.31 },
        { upTo: 695_800, base: 125_599, rate: 0.36 },
        { upTo: 887_000, base: 185_215, rate: 0.39 },
        { upTo: 1_878_600, base: 259_783, rate: 0.41 },
        { upTo: null, base: 666_339, rate: 0.45 },
    ],
    primaryRebate: 17_820,
    uifCeiling: 17_712,
    uifRate: 0.01,
    sdlRegistered: false,
    sdlRate: 0.01,
    payday: 25,
}

/** Annual tax in rand on annual taxable income in rand, before rebates. */
export function annualTax(income: number, brackets: readonly Bracket[]): number
{
    let lower = 0
    for (const b of brackets) {
        if (b.upTo === null || income <= b.upTo) return b.base + (income - lower) * b.rate
        lower = b.upTo
    }
    return 0
}

export interface Payslip
{
    readonly gross: number
    readonly paye: number
    readonly uif: number
    readonly uifEmployer: number
    readonly sdl: number
    readonly net: number
    readonly taxTable: string
}

/** A monthly payslip for a gross salary in cents, using the annualised method. */
export function payslipFor(grossCents: number, overrides: Partial<PayrollSettings> = {}): Payslip
{
    const s = { ...DEFAULT_PAYROLL, ...overrides }
    const annualRand = (grossCents / 100) * 12
    const yearly = Math.max(0, annualTax(annualRand, s.brackets) - s.primaryRebate)
    const paye = Math.round((yearly / 12) * 100)
    const uif = Math.round(Math.min(grossCents, s.uifCeiling * 100) * s.uifRate)
    const sdl = s.sdlRegistered ? Math.round(grossCents * s.sdlRate) : 0
    return { gross: grossCents, paye, uif, uifEmployer: uif, sdl, net: grossCents - paye - uif, taxTable: s.taxTableName }
}
