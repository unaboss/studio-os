import { createHash } from 'node:crypto'
import { extractJson, type Inference } from './inference.ts'

export interface ParsedLine
{
    readonly date: string
    readonly amount: number
    readonly balance: number | null
    readonly description: string
    readonly reference: string | null
}

/**
 * Identifies a statement format by its first lines with digits blanked out,
 * so the next statement from the same bank reuses the parser.
 */
export function formatSignature(csv: string): string
{
    const head = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 3).join('\n')
    return createHash('sha256').update(head.replace(/\d/g, '0').replace(/\s+/g, ' ').toLowerCase()).digest('hex').slice(0, 16)
}

const PROMPT = `You write small, pure JavaScript functions that read bank statement exports.
Write the BODY of a function that receives one argument, \`input\` (the whole file as a string), and returns an array of
{ "date": "YYYY-MM-DD", "amount": integer cents (money in positive, money out negative), "balance": integer cents or null, "description": string, "reference": string or null }.
Rules: no imports, no require, no network, no file access, no globals beyond standard JavaScript. Skip header, summary and blank lines.
Reply with one JSON object only: {"code": "<function body>", "notes": "<one sentence on the format>"}`

/** Asks the model for a parser for an unfamiliar statement format. The code is untrusted. */
export async function writeBankParser(inference: Inference, csv: string): Promise<{ code: string; notes: string }>
{
    const sample = csv.split(/\r?\n/).slice(0, 40).join('\n')
    const reply = await inference.chat(
        [
            { role: 'system', content: PROMPT },
            { role: 'user', content: `Here are the first lines of the statement:\n\n${sample}` },
        ],
        { maxTokens: 1800, temperature: 0 },
    )
    const parsed = extractJson(reply) as { code?: unknown; notes?: unknown }
    if (typeof parsed.code !== 'string' || !parsed.code.trim()) throw new Error('The model did not return any code')
    if (parsed.code.length > 20_000) throw new Error('The parser the model wrote is too long to trust')
    return { code: parsed.code, notes: String(parsed.notes ?? '') }
}

/** Checks what a sandboxed parser returned before any of it touches the books. */
export function checkParsedLines(output: unknown): ParsedLine[]
{
    if (!Array.isArray(output)) throw new Error('The parser did not return a list')
    if (output.length > 20_000) throw new Error('The parser returned too many lines')
    return output.map((row, i) => {
        const r = row as Record<string, unknown>
        const where = `line ${i + 1}`
        if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || Number.isNaN(Date.parse(r.date))) throw new Error(`${where}: bad date`)
        if (!Number.isInteger(r.amount) || r.amount === 0) throw new Error(`${where}: amount must be whole cents and not zero`)
        if (r.balance !== null && r.balance !== undefined && !Number.isInteger(r.balance)) throw new Error(`${where}: balance must be whole cents`)
        if (typeof r.description !== 'string') throw new Error(`${where}: description must be text`)
        return {
            date: r.date,
            amount: r.amount as number,
            balance: (r.balance ?? null) as number | null,
            description: r.description.slice(0, 300),
            reference: typeof r.reference === 'string' && r.reference ? r.reference.slice(0, 100) : null,
        }
    })
}
