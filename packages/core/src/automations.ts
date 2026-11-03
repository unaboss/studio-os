import type { AutomationRule, Condition, StudioEvent } from './types.ts'

/** Reads `a.b.c` out of an object; undefined when any step is missing. */
export function getPath(source: unknown, path: string): unknown
{
    let cur: unknown = source
    for (const part of path.split('.')) {
        if (cur === null || typeof cur !== 'object') return undefined
        cur = (cur as Record<string, unknown>)[part]
    }
    return cur
}

function check(event: StudioEvent, c: Condition): boolean
{
    const v = getPath(event, c.path)
    switch (c.op) {
        case 'exists': return v !== undefined && v !== null
        case 'eq': return v === c.value
        case 'neq': return v !== c.value
        case 'gt': return typeof v === 'number' && typeof c.value === 'number' && v > c.value
        case 'gte': return typeof v === 'number' && typeof c.value === 'number' && v >= c.value
        case 'lt': return typeof v === 'number' && typeof c.value === 'number' && v < c.value
        case 'lte': return typeof v === 'number' && typeof c.value === 'number' && v <= c.value
        case 'contains':
            if (typeof v === 'string') return typeof c.value === 'string' && v.includes(c.value)
            return Array.isArray(v) && v.includes(c.value)
    }
}

/** Does this rule fire for this event? `*` matches every event. */
export function ruleMatches(rule: AutomationRule, event: StudioEvent): boolean
{
    if (!rule.enabled) return false
    if (rule.when !== '*' && rule.when !== event.name) return false
    return rule.conditions.every((c) => check(event, c))
}

const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g

/**
 * Fills `{{payload.record.id}}` style references from the event.
 * A value that is exactly one token keeps its type (a number stays a number).
 */
export function fillParams(params: Readonly<Record<string, unknown>>, event: StudioEvent): Record<string, unknown>
{
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(params)) {
        if (typeof value !== 'string') {
            out[key] = value
            continue
        }
        const whole = value.match(/^\{\{\s*([\w.]+)\s*\}\}$/)
        if (whole) {
            out[key] = getPath(event, whole[1]!)
            continue
        }
        out[key] = value.replace(TOKEN, (_, path: string) => {
            const v = getPath(event, path)
            return v === undefined || v === null ? '' : String(v)
        })
    }
    return out
}

export interface AutomationRow
{
    id: string
    name: string
    enabled: boolean
    when_event: string
    conditions: Condition[] | string
    action: string
    params: Record<string, unknown> | string
}

export function toRule(row: AutomationRow): AutomationRule
{
    const parse = <T>(v: T | string): T => (typeof v === 'string' ? JSON.parse(v) : v)
    return {
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        when: row.when_event,
        conditions: parse(row.conditions),
        action: row.action,
        params: parse(row.params),
    }
}
