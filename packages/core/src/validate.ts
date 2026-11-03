import type { FieldDef, RecordTypeDef } from './types.ts'

export class ValidationError extends Error
{
    constructor(readonly problems: string[])
    {
        super(problems.join('; '))
    }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Checks record data against its type's fields (built-in plus custom).
 * Unknown keys are rejected so a typo never silently disappears.
 * With `partial`, missing required fields are allowed (an update).
 */
export function validateData(rt: RecordTypeDef, data: Record<string, unknown>, partial = false): Record<string, unknown>
{
    const problems: string[] = []
    const out: Record<string, unknown> = {}
    const byKey = new Map(rt.fields.map((f) => [f.key, f]))
    for (const key of Object.keys(data)) {
        if (!byKey.has(key)) problems.push(`${rt.label} has no field "${key}"`)
    }
    for (const field of rt.fields) {
        const has = Object.prototype.hasOwnProperty.call(data, field.key)
        const value = data[field.key]
        if (!has || value === undefined) {
            if (field.required && !partial) problems.push(`${field.label} is required`)
            continue
        }
        if (value === null || value === '') {
            if (field.required) problems.push(`${field.label} is required`)
            else out[field.key] = null
            continue
        }
        const problem = checkValue(field, value)
        if (problem) problems.push(problem)
        else out[field.key] = value
    }
    if (problems.length > 0) throw new ValidationError(problems)
    return out
}

function checkValue(field: FieldDef, value: unknown): string | null
{
    switch (field.kind) {
        case 'text':
        case 'longtext':
        case 'user':
        case 'record':
            return typeof value === 'string' ? null : `${field.label} must be text`
        case 'url':
            return typeof value === 'string' && /^https?:\/\//.test(value) ? null : `${field.label} must be a web address`
        case 'number':
            return typeof value === 'number' && Number.isFinite(value) ? null : `${field.label} must be a number`
        case 'money':
            return Number.isInteger(value) ? null : `${field.label} must be a whole number of cents`
        case 'date':
            return typeof value === 'string' && DATE.test(value) ? null : `${field.label} must be a date (YYYY-MM-DD)`
        case 'boolean':
            return typeof value === 'boolean' ? null : `${field.label} must be yes or no`
        case 'users':
            return Array.isArray(value) && value.every((v) => typeof v === 'string') ? null : `${field.label} must be a list of people`
        case 'select':
            return typeof value === 'string' && (field.options ?? []).includes(value)
                ? null
                : `${field.label} must be one of: ${(field.options ?? []).join(', ')}`
    }
}
