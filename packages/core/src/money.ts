/** Money is always whole cents. */
export function formatMoney(cents: number, currency = 'ZAR'): string
{
    const sign = cents < 0 ? '-' : ''
    const abs = Math.abs(cents)
    const rands = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
    const symbol = currency === 'ZAR' ? 'R' : `${currency} `
    return `${sign}${symbol}${rands}.${String(abs % 100).padStart(2, '0')}`
}

/**
 * Splits a total across shares (e.g. 40/30/30) so the parts always add up
 * to the total exactly; any rounding remainder goes to the last part.
 */
export function splitByShares(totalCents: number, shares: readonly number[]): number[]
{
    const sum = shares.reduce((a, b) => a + b, 0)
    if (shares.length === 0 || sum <= 0) return []
    const parts = shares.map((s) => Math.floor((totalCents * s) / sum))
    const remainder = totalCents - parts.reduce((a, b) => a + b, 0)
    parts[parts.length - 1]! += remainder
    return parts
}

export function daysBetween(fromIso: string, to: Date): number
{
    const from = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`)
    const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
    return Math.round((end - from) / 86_400_000)
}
