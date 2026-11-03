import { randomUUID } from 'node:crypto'

/** A readable, unique id such as `inv_3f2a9c1e5b7d`. */
export function newId(prefix: string): string
{
    return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}
