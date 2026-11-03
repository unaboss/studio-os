import { createHash } from 'node:crypto'
import { ValidationError } from '@studio-os/core'

export interface BankLine
{
    readonly date: string
    /** Cents; money in is positive, money out negative. */
    readonly amount: number
    readonly balance: number | null
    readonly description: string
    readonly reference: string | null
    /** Stable id so importing an overlapping statement never doubles a line. */
    readonly fingerprint: string
}

const MONTHS: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

/** Splits one CSV line, honouring quotes. */
export function splitCsvLine(line: string, sep = ','): string[]
{
    const out: string[] = []
    let cur = ''
    let quoted = false
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]!
        if (quoted) {
            if (ch === '"' && line[i + 1] === '"') {
                cur += '"'
                i++
            } else if (ch === '"') quoted = false
            else cur += ch
        } else if (ch === '"') quoted = true
        else if (ch === sep) {
            out.push(cur.trim())
            cur = ''
        } else cur += ch
    }
    out.push(cur.trim())
    return out
}

/** Accepts the date shapes South African banks export. Returns YYYY-MM-DD or null. */
export function parseDate(raw: string): string | null
{
    const s = raw.trim()
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s)
    if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
    m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
    if (m) return `${m[1]}-${m[2]}-${m[3]}`
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s)
    if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
    m = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{4})/.exec(s)
    if (m && MONTHS[m[2]!.toLowerCase()]) return `${m[3]}-${MONTHS[m[2]!.toLowerCase()]}-${m[1]!.padStart(2, '0')}`
    return null
}

/** "R1 234.56", "-1,234.56", "(12.00)", "500.00 Dr" → cents. */
export function parseAmount(raw: string): number | null
{
    let s = raw.trim()
    if (!s) return null
    let sign = 1
    if (/^\(.*\)$/.test(s)) {
        sign = -1
        s = s.slice(1, -1)
    }
    if (/\bdr$/i.test(s)) {
        sign = -1
        s = s.replace(/\s*dr$/i, '')
    }
    s = s.replace(/\s*cr$/i, '').replace(/^R\s?/i, '').replace(/[\s ]/g, '')
    if (s.startsWith('-')) {
        sign *= -1
        s = s.slice(1)
    }
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '')
    else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.')
    if (!/^\d+(\.\d+)?$/.test(s)) return null
    return sign * Math.round(Number(s) * 100)
}

interface Columns
{
    date: number
    description: number[]
    amount?: number
    moneyIn?: number
    moneyOut?: number
    fee?: number
    balance?: number
    reference?: number
}

function findColumns(header: string[]): Columns | null
{
    const h = header.map((c) => c.toLowerCase().replace(/[^a-z ]/g, '').trim())
    const find = (...names: string[]) => {
        for (const n of names) {
            const i = h.findIndex((c) => c === n)
            if (i >= 0) return i
        }
        for (const n of names) {
            const i = h.findIndex((c) => c.includes(n))
            if (i >= 0) return i
        }
        return undefined
    }
    const date = find('transaction date', 'date', 'posting date', 'value date')
    if (date === undefined) return null
    const description = ['description', 'narrative', 'details', 'transaction description', 'original description']
        .map((n) => h.indexOf(n))
        .filter((i) => i >= 0)
        .slice(0, 1)
    const cols: Columns = { date, description: description.length ? description : [find('description', 'narrative', 'details') ?? -1].filter((i) => i >= 0) }
    cols.amount = find('amount', 'transaction amount')
    cols.moneyIn = find('money in', 'credit', 'credits', 'deposit')
    cols.moneyOut = find('money out', 'debit', 'debits', 'withdrawal')
    cols.fee = find('fee', 'fees', 'charges')
    cols.balance = find('balance', 'running balance')
    cols.reference = find('reference', 'ref')
    if (cols.amount === undefined && cols.moneyIn === undefined && cols.moneyOut === undefined) return null
    return cols
}

function fingerprint(date: string, amount: number, balance: number | null, description: string, n: number): string
{
    return createHash('sha256').update(`${date}|${amount}|${balance ?? ''}|${description.toLowerCase()}|${n}`).digest('hex').slice(0, 24)
}

/**
 * Reads a bank statement CSV: FNB, Absa, Nedbank and Capitec exports with a
 * header row, and Standard Bank's headerless HIST lines. Anything it cannot
 * read is reported, never guessed at; the agent can then write a parser for
 * that format, which runs in the sandbox.
 */
export function parseBankCsv(csv: string): BankLine[]
{
    const rows = csv
        .replace(/^﻿/, '')
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '')
    const sep = rows.slice(0, 10).some((l) => l.split(';').length > l.split(',').length) ? ';' : ','
    const cells = rows.map((l) => splitCsvLine(l, sep))
    const raw: Omit<BankLine, 'fingerprint'>[] = []

    if (cells.some((c) => c[0]?.toUpperCase() === 'HIST')) {
        // Standard Bank: HIST,YYYYMMDD,,amount,description,extra,...
        for (const c of cells) {
            if (c[0]?.toUpperCase() !== 'HIST') continue
            const date = parseDate(c[1] ?? '')
            const amount = parseAmount(c[3] ?? '')
            if (!date || amount === null) continue
            raw.push({ date, amount, balance: null, description: [c[4], c[5]].filter(Boolean).join(' ').trim(), reference: null })
        }
    } else {
        const headerAt = cells.findIndex((c) => findColumns(c) !== null)
        if (headerAt < 0) throw new ValidationError(['This statement has no date and amount columns that Studio OS recognises'])
        const cols = findColumns(cells[headerAt]!)!
        for (const c of cells.slice(headerAt + 1)) {
            const date = parseDate(c[cols.date] ?? '')
            if (!date) continue
            let amount: number | null = null
            if (cols.amount !== undefined) amount = parseAmount(c[cols.amount] ?? '')
            if (amount === null && (cols.moneyIn !== undefined || cols.moneyOut !== undefined)) {
                const moneyIn = cols.moneyIn !== undefined ? parseAmount(c[cols.moneyIn] ?? '') ?? 0 : 0
                const moneyOut = cols.moneyOut !== undefined ? parseAmount(c[cols.moneyOut] ?? '') ?? 0 : 0
                const fee = cols.fee !== undefined ? parseAmount(c[cols.fee] ?? '') ?? 0 : 0
                amount = Math.abs(moneyIn) - Math.abs(moneyOut) - Math.abs(fee)
            }
            if (amount === null || amount === 0) continue
            raw.push({
                date,
                amount,
                balance: cols.balance !== undefined ? parseAmount(c[cols.balance] ?? '') : null,
                description: cols.description.map((i) => c[i] ?? '').join(' ').replace(/\s+/g, ' ').trim(),
                reference: cols.reference !== undefined && c[cols.reference] ? c[cols.reference]! : null,
            })
        }
    }

    const seen = new Map<string, number>()
    return raw.map((l) => {
        const key = `${l.date}|${l.amount}|${l.balance ?? ''}|${l.description.toLowerCase()}`
        const n = seen.get(key) ?? 0
        seen.set(key, n + 1)
        return { ...l, fingerprint: fingerprint(l.date, l.amount, l.balance, l.description, n) }
    })
}
