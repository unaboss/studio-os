// Round avatars, the way GitHub and HackerOne show people: a photo when we
// know their GitHub login, otherwise a symmetric identicon drawn from their
// email, so everyone gets a face that stays the same everywhere.
import { useState } from 'react'

const hash = (key: string) => [...key].reduce((h, ch) => (Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0), 2166136261)

const HUES = [168, 200, 222, 262, 330, 18, 38, 140]
export const hueOf = (key: string) => HUES[hash(key) % HUES.length]!

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('')
/** Kept for older callers: a steady colour per person. */
export const colour = (key: string) => `oklch(0.55 0.11 ${hueOf(key)})`

/** A 5x5 mirrored grid, like GitHub's default avatars. */
function Identicon({ seed, size }: { seed: string; size: number })
{
    const h = hash(seed)
    const hue = hueOf(seed)
    const cells: [number, number][] = []
    for (let i = 0; i < 15; i++) {
        if ((h >>> i) & 1 || (hash(seed + i) & 3) === 0) {
            const col = Math.floor(i / 5)
            const row = i % 5
            cells.push([col, row])
            if (col < 2) cells.push([4 - col, row])
        }
    }
    return (
        <svg viewBox="-1.4 -1.4 7.8 7.8" width={size} height={size} aria-hidden="true" className="identicon" style={{ ['--hue' as string]: hue }}>
            <rect x={-1.4} y={-1.4} width={7.8} height={7.8} className="identicon-bg" />
            {cells.map(([x, y]) => <rect key={`${x}${y}`} x={x} y={y} width={1.02} height={1.02} className="identicon-cell" />)}
        </svg>
    )
}

const realLogin = (github: string | null | undefined, email: string | undefined) =>
    github && !/@demo\.studio$/i.test(email ?? '') && /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(github) ? github : null

export function Avatar({ name, email, github, size = 32, ring }: { name: string; email?: string; github?: string | null; size?: number; ring?: boolean })
{
    const login = realLogin(github, email)
    const [failed, setFailed] = useState(false)
    return (
        <span className={`av ${ring ? 'ring' : ''}`} style={{ width: size, height: size }} title={name}>
            {login && !failed
                ? <img src={`https://github.com/${login}.png?size=${Math.min(460, size * 2)}`} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} />
                : <Identicon seed={(email || name).toLowerCase()} size={size} />}
        </span>
    )
}
