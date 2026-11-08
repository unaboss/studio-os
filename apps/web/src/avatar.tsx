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

function cellsOf(seed: string): [number, number][]
{
    const h = hash(seed)
    const cells: [number, number][] = []
    for (let i = 0; i < 15; i++) {
        if ((h >>> i) & 1 || (hash(seed + i) & 3) === 0) {
            const col = Math.floor(i / 5)
            const row = i % 5
            cells.push([col, row])
            if (col < 2) cells.push([4 - col, row])
        }
    }
    return cells
}

/** A 5x5 mirrored grid, like GitHub's default avatars. */
function Identicon({ seed, size, x, y }: { seed: string; size: number; x?: number; y?: number })
{
    return (
        <svg viewBox="-1.4 -1.4 7.8 7.8" x={x} y={y} width={size} height={size} aria-hidden="true" className="identicon" style={{ ['--hue' as string]: hueOf(seed) }}>
            <rect x={-1.4} y={-1.4} width={7.8} height={7.8} className="identicon-bg" />
            {cellsOf(seed).map(([cx, cy]) => <rect key={`${cx}${cy}`} x={cx} y={cy} width={1.02} height={1.02} className="identicon-cell" />)}
        </svg>
    )
}

export type Shape = 'circle' | 'diamond' | 'square'

/** The outline of a node shape centred on x,y, sized to look as big as a circle of radius r. */
export function shapeD(shape: Shape, x: number, y: number, r: number): string
{
    if (shape === 'diamond') {
        const R = r * 1.32
        return `M${x},${y - R} L${x + R},${y} L${x},${y + R} L${x - R},${y} Z`
    }
    if (shape === 'square') {
        const h = r * 0.92
        const k = Math.min(3, h * 0.3)
        return `M${x - h + k},${y - h} H${x + h - k} Q${x + h},${y - h} ${x + h},${y - h + k} V${y + h - k} Q${x + h},${y + h} ${x + h - k},${y + h} H${x - h + k} Q${x - h},${y + h} ${x - h},${y + h - k} V${y - h + k} Q${x - h},${y - h} ${x - h + k},${y - h} Z`
    }
    return `M${x - r},${y} a${r},${r} 0 1 0 ${r * 2},0 a${r},${r} 0 1 0 ${-r * 2},0 Z`
}

/** A face inside an SVG drawing, for the tree's commits and cards, cut to the commit's shape. */
export function SvgFace({ id, x, y, r, name, email, github, shape = 'circle' }: { id: string; x: number; y: number; r: number; name: string; email?: string; github?: string | null; shape?: Shape })
{
    const login = realLogin(github, email)
    return (
        <g aria-label={name}>
            <clipPath id={id}><path d={shapeD(shape, x, y, r)} /></clipPath>
            <g clipPath={`url(#${id})`}>
                {login
                    ? <image href={`https://github.com/${login}.png?size=64`} x={x - r} y={y - r} width={r * 2} height={r * 2} preserveAspectRatio="xMidYMid slice" />
                    : <Identicon seed={(email || name).toLowerCase()} size={r * 2} x={x - r} y={y - r} />}
            </g>
        </g>
    )
}

/** Demo people are made up; their logins may belong to real strangers on GitHub. */
export const isDemo = (email: string | undefined) => /@demo\.studio$/i.test(email ?? '')

/** A GitHub login we may show and link to, or null. */
export const realLogin = (github: string | null | undefined, email: string | undefined) =>
    github && !isDemo(email) && /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(github) ? github : null

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
