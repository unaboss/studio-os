import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>

export async function hashPassword(password: string): Promise<string>
{
    const salt = randomBytes(16)
    const key = await scrypt(password, salt, 32)
    return ['scrypt', salt.toString('base64url'), key.toString('base64url')].join('$')
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean>
{
    if (!stored) return false
    const [kind, salt, key] = stored.split('$')
    if (kind !== 'scrypt' || !salt || !key) return false
    const expected = Buffer.from(key, 'base64url')
    const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length)
    return timingSafeEqual(expected, actual)
}

const sign = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('base64url')

/** A session cookie value: user id and expiry, signed. No server-side session table. */
export function sessionToken(secret: string, userId: string, days = 14): string
{
    const value = `${userId}.${Date.now() + days * 86_400_000}`
    return `${value}.${sign(secret, value)}`
}

export function readSession(secret: string, token: string | undefined): string | null
{
    if (!token) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [userId, expires, mac] = parts as [string, string, string]
    const good = Buffer.from(sign(secret, `${userId}.${expires}`))
    const given = Buffer.from(mac)
    if (good.length !== given.length || !timingSafeEqual(good, given)) return null
    if (Number(expires) < Date.now()) return null
    return userId
}

/** Checks GitHub's X-Hub-Signature-256 header against the raw body. */
export function verifyGithubSignature(secret: string, rawBody: string, header: string | undefined): boolean
{
    if (!header?.startsWith('sha256=')) return false
    const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`)
    const given = Buffer.from(header)
    return expected.length === given.length && timingSafeEqual(expected, given)
}
