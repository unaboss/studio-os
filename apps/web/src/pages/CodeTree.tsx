import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useSearchParams } from 'react-router-dom'
import { ago, announceChange, api, useApi } from '../api.ts'
import { Avatar, realLogin, SvgFace } from '../avatar.tsx'
import { Icon } from '../icons.tsx'
import { Dialog, Pill, useStudio } from '../ui.tsx'

export { colour, initials } from '../avatar.tsx'

// ---- Data from /api/code ----

interface Commit { sha: string; parents: string[]; author: string; email: string; date: string; subject: string }
interface Graph { repo: string; defaultBranch: string; branches: { name: string; sha: string }[]; commits: Commit[]; fetchedAt: string | null }
export interface RepoRow
{
    projectId: string; project: string; status: string; repo: string; clientId: string; client: string
    health?: 'attention' | 'watch' | 'good'; reasons?: string[]; openBranches?: number; lastCommit?: string | null
}
interface CommitDetail { commit: Commit & { body: string }; files: { path: string; added: number | null; removed: number | null }[]; patch: string; truncated: boolean }
interface FileAt { path: string; content: string; binary: boolean; truncated: boolean; size: number }
interface PersonLite { id: string; name: string; email: string; github: string | null }
interface Preview { url: string | null; reason?: string }

// ---- Turning history into a tree ----

/** One limb of the tree: the trunk (the default branch) or a branch growing off it. */
interface Limb
{
    id: number
    name: string
    /** Oldest first. */
    commits: string[]
    /** Where it grows from; null for the trunk. */
    fork: string | null
    /** The merge commit it grafts back into, if it was merged. */
    mergeInto: string | null
    open: boolean
    pr: string | null
    side: 1 | -1
    lane: number
}

interface Placed { x: number; y: number; limb: number }

const TOP = 120
const BOTTOM = 150

const short = (name: string) => (name.length > 26 ? `${name.slice(0, 25)}…` : name)
/** A branch name as an idea: feature/yoco-payments becomes Yoco payments. */
const human = (name: string) => {
    const words = name.replace(/^(feature|feat|fix|bugfix|hotfix|chore|refactor|release)\//i, '').replace(/[-_/.]+/g, ' ').trim()
    return words ? words[0]!.toUpperCase() + words.slice(1) : name
}
const kindOf = (name: string) => (/^(fix|bugfix|hotfix)\//i.test(name) ? 'fix' : /^(feature|feat)\//i.test(name) ? 'feature' : 'branch')
const plain = (subject: string) => {
    const pr = /Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subject)
    if (pr) return `Merged ${human(pr[2]!).toLowerCase()} #${pr[1]}`
    const br = /Merge branch '([^']+)'/.exec(subject)
    return br ? `Merged ${human(br[1]!).toLowerCase()}` : subject
}
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)
const cardTitle = (l: Limb) => clip(human(l.name), 30)
const cardSub = (l: Limb) => `${kindOf(l.name)} · ${l.commits.length} ${l.commits.length === 1 ? 'commit' : 'commits'} · ${l.open ? 'growing' : l.pr ? `merged ${l.pr}` : 'merged'}`
const tagWidth = (l: Limb) => Math.max(cardTitle(l).length * 7.3, cardSub(l).length * 5.9) + 26
const LABEL = 34

function grow(g: Graph, minWidth = 0, minHeight = 0)
{
    const asc = [...g.commits].reverse()
    // Fit the history to the screen when it can; a long history scrolls.
    const room = minHeight ? (minHeight - TOP - BOTTOM) / Math.max(1, asc.length) : 560 / Math.max(1, asc.length)
    const ROW = Math.round(Math.min(64, Math.max(28, room)))
    const index = new Map(asc.map((c, i) => [c.sha, i]))
    const bySha = new Map(asc.map((c) => [c.sha, c]))
    const owner = new Map<string, number>()
    const limbs: Limb[] = []

    const walk = (start: string | undefined, name: string, open: boolean, mergeInto: string | null, pr: string | null): Limb | null => {
        const own: string[] = []
        let s = start
        while (s && bySha.has(s) && !owner.has(s)) {
            own.push(s)
            s = bySha.get(s)!.parents[0]
        }
        if (!own.length) return null
        const limb: Limb = { id: limbs.length, name, commits: own.reverse(), fork: s && owner.has(s) ? s : null, mergeInto, open, pr, side: 1, lane: 0 }
        for (const sha of limb.commits) owner.set(sha, limb.id)
        limbs.push(limb)
        return limb
    }

    const head = g.branches.find((b) => b.name === g.defaultBranch)?.sha ?? asc.at(-1)?.sha
    walk(head, g.defaultBranch, true, null, null)

    for (const ref of g.branches.filter((b) => b.name !== g.defaultBranch).sort((a, b) => (index.get(a.sha) ?? 0) - (index.get(b.sha) ?? 0))) {
        walk(ref.sha, ref.name, true, null, null)
    }

    // Branches that were merged and deleted live on as the second parent of a merge.
    for (let changed = true; changed;) {
        changed = false
        for (const c of asc) {
            if (!owner.has(c.sha)) continue
            for (const p of c.parents.slice(1)) {
                const known = owner.get(p)
                if (known !== undefined) {
                    const limb = limbs[known]!
                    if (known !== 0 && limb.commits.at(-1) === p && !limb.mergeInto) limb.mergeInto = c.sha
                    continue
                }
                const prMatch = /Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(c.subject)
                const branchMatch = /Merge branch '([^']+)'/.exec(c.subject)
                const name = prMatch ? prMatch[2]! : branchMatch ? branchMatch[1]! : 'merged branch'
                if (walk(p, name, false, c.sha, prMatch ? `#${prMatch[1]}` : null)) changed = true
            }
        }
    }

    // Lanes: each limb takes the nearest free lane on the side with more room.
    const taken: { side: 1 | -1; lane: number; from: number; to: number }[] = []
    const span = (l: Limb) => {
        const first = index.get(l.fork ?? l.commits[0]!) ?? 0
        const last = Math.max(index.get(l.commits.at(-1)!) ?? 0, l.mergeInto ? index.get(l.mergeInto) ?? 0 : 0)
        return [first, last + 1.5] as const
    }
    let flip: 1 | -1 = 1
    for (const limb of limbs.slice(1).sort((a, b) => span(a)[0] - span(b)[0])) {
        const [from, to] = span(limb)
        const free = (side: 1 | -1) => {
            for (let lane = 1; ; lane++) if (!taken.some((t) => t.side === side && t.lane === lane && t.from < to && from < t.to)) return lane
        }
        const right = free(1)
        const left = free(-1)
        const side: 1 | -1 = right < left ? 1 : left < right ? -1 : flip
        flip = side === 1 ? -1 : 1
        limb.side = side
        limb.lane = side === 1 ? right : left
        taken.push({ side, lane: limb.lane, from, to })
    }

    // Spread the branches out to use the screen, within reason.
    const lanes = Math.max(1, ...limbs.slice(1).map((l) => l.lane))
    const LANE = minWidth ? Math.round(Math.min(124, Math.max(76, (minWidth / 2 - 300) / lanes))) : 78
    const reach = (side: 1 | -1) => Math.max(230, ...limbs.filter((l) => l.id !== 0 && l.side === side).map((l) => l.lane * LANE + 40 + Math.max(tagWidth(l), LABEL * 6.1)))
    const left = reach(-1) + 90
    const right = reach(1) + 40
    const extra = Math.max(0, minWidth - left - right)
    const cx = left + extra / 2
    const width = left + right + extra
    const height = Math.max(minHeight, asc.length * ROW + TOP + BOTTOM)
    const groundY = height - BOTTOM + 12
    const yOf = (sha: string) => groundY - 36 - (index.get(sha) ?? 0) * ROW

    const at = new Map<string, Placed>()
    limbs[0]?.commits.forEach((sha) => {
        const i = index.get(sha) ?? 0
        at.set(sha, { x: cx + Math.sin(i * 0.45) * 3, y: yOf(sha), limb: 0 })
    })
    for (const limb of limbs.slice(1)) {
        limb.commits.forEach((sha, k) => {
            const r = k === 0 ? 0.72 : 1
            at.set(sha, { x: cx + limb.side * (limb.lane * LANE * r + Math.min(k, 5) * 4), y: yOf(sha), limb: limb.id })
        })
    }
    return { asc, index, bySha, limbs, at, cx, width, height, groundY, ROW }
}

type Grown = ReturnType<typeof grow>

/** The history a commit stands on, oldest first: what you watch grow. */
function lineage(t: Grown, tip: string): string[]
{
    const out: string[] = []
    for (let s: string | undefined = tip; s && t.bySha.has(s); s = t.bySha.get(s)!.parents[0]) out.push(s)
    return out.reverse()
}

// ---- Drawing: a real-looking tree, kept quiet ----

type Pt = [number, number]

interface Geo { d: string; left: Pt[]; right: Pt[]; mid: Pt[]; w: number[]; len: number }

/** A tapering limb through points: its outline, plus the edges and centre we draw grain and rings from. */
function limbGeo(points: Pt[], width: (u: number) => number, limb: boolean): Geo | null
{
    const samples: Pt[] = []
    for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1]!
        const [x1, y1] = points[i]!
        const dx = x1 - x0
        const dy = y1 - y0
        // The first stretch of a branch leaves the trunk sideways, then turns up to the light.
        const c1: Pt = limb && i === 1 ? [x0 + dx * 0.55, y0 + dy * 0.05] : [x0, y0 + dy / 2]
        const c2: Pt = limb && i === 1 ? [x1, y0 + dy * 0.55] : [x1, y0 + dy / 2]
        for (let s = i === 1 ? 0 : 1; s <= 12; s++) {
            const t = s / 12
            const a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, d = t ** 3
            samples.push([a * x0 + b * c1[0] + c * c2[0] + d * x1, a * y0 + b * c1[1] + c * c2[1] + d * y1])
        }
    }
    if (samples.length < 2) return null
    const left: Pt[] = []
    const right: Pt[] = []
    const ws: number[] = []
    let len = 0
    samples.forEach(([x, y], i) => {
        const [px, py] = samples[Math.max(0, i - 1)]!
        const [nx, ny] = samples[Math.min(samples.length - 1, i + 1)]!
        if (i) len += Math.hypot(x - px, y - py)
        const l = Math.hypot(nx - px, ny - py) || 1
        const w = width(i / (samples.length - 1)) / 2
        ws.push(w)
        const ox = (-(ny - py) / l) * w
        const oy = ((nx - px) / l) * w
        left.push([x + ox, y + oy])
        right.push([x - ox, y - oy])
    })
    const f = (p: Pt) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`
    const tipR = ws.at(-1)!.toFixed(1)
    return { d: `M${left.map(f).join(' L')} A${tipR},${tipR} 0 0 1 ${f(right.at(-1)!)} L${[...right].reverse().map(f).join(' L')} Z`, left, right, mid: samples, w: ws, len }
}

const limbPath = (points: Pt[], width: (u: number) => number, limb: boolean) => limbGeo(points, width, limb)?.d ?? ''

/** Wood as line art: an outline, grain lines on the shaded side and cross-section rings, so it reads in 3D. */
function Wood({ geo, className, rings = true }: { geo: Geo | null; className: string; rings?: boolean })
{
    if (!geo) return null
    const f = (p: Pt) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`
    const n = geo.mid.length
    const along = (k: number) => {
        // A grain line k of the way from the centre to the shaded (right-hand) edge; negative is the lit side.
        const pts = geo.mid.map((m, i) => {
            const e = k >= 0 ? geo.right[i]! : geo.left[i]!
            const a = Math.abs(k)
            return [m[0] + (e[0] - m[0]) * a, m[1] + (e[1] - m[1]) * a] as Pt
        })
        // Grain fades out before the fine tip.
        const stop = Math.max(2, Math.floor(n * 0.82))
        return `M${pts.slice(0, stop).map(f).join(' L')}`
    }
    const ringEvery = Math.max(3, Math.round(n / Math.max(1, geo.len / 38)))
    const ringPaths: string[] = []
    if (rings) {
        for (let i = ringEvery; i < n - 3; i += ringEvery) {
            if (geo.w[i]! < 2.6) break
            const l = geo.left[i]!
            const r = geo.right[i]!
            const m = geo.mid[i]!
            const [px, py] = geo.mid[i - 1]!
            const [nx, ny] = geo.mid[Math.min(n - 1, i + 1)]!
            const tl = Math.hypot(nx - px, ny - py) || 1
            const bulge = geo.w[i]! * 0.55
            // Bowed against the growth, like an ellipse seen from a little above.
            const c: Pt = [m[0] - ((nx - px) / tl) * bulge, m[1] - ((ny - py) / tl) * bulge]
            ringPaths.push(`M${f(l)} Q${f(c)} ${f(r)}`)
        }
    }
    const wide = Math.max(...geo.w) > 4
    return (
        <g className={`wood ${className}`}>
            <path className="wood-body" d={geo.d} />
            {wide ? <path className="wood-grain" d={along(0.55)} /> : null}
            {wide ? <path className="wood-grain" d={along(0.82)} /> : null}
            {wide && Math.max(...geo.w) > 8 ? <path className="wood-grain light" d={along(-0.5)} /> : null}
            {ringPaths.map((d, i) => <path key={i} className="wood-ring" d={d} />)}
        </g>
    )
}

/** The crown, drawn the way an illustrator would: overlapping scalloped outlines with a little hatching. */
function Crown({ clusters, kind }: { clusters: { key: string; x: number; y: number; r: number }[]; kind: 'live' | 'old' })
{
    const blobs: { k: string; x: number; y: number; r: number }[] = []
    for (const c of clusters) {
        const n = c.r > 60 ? 10 : c.r > 30 ? 6 : 4
        for (let j = 0; j < n; j++) {
            const ang = (j / n) * Math.PI * 2 + seeded(c.key, j) * 0.8
            const dist = c.r * (0.45 + seeded(c.key, j + 5) * 0.25)
            blobs.push({ k: `${c.key}${j}`, x: c.x + Math.cos(ang) * dist, y: c.y + Math.sin(ang) * dist * 0.75, r: c.r * (0.42 + seeded(c.key, j + 11) * 0.22) })
        }
        blobs.push({ k: `${c.key}c`, x: c.x, y: c.y, r: c.r * 0.55 })
    }
    // Upper masses first, so lower ones overlap them like foliage seen from the front.
    blobs.sort((a, b) => a.y - b.y)
    return (
        <g className={`crown ${kind}`}>
            {blobs.map((b) => (
                <g key={b.k}>
                    <circle className="crown-mass" cx={b.x} cy={b.y} r={b.r} />
                    <path className="crown-hatch" d={`M${(b.x + b.r * 0.62 * Math.cos(0.35)).toFixed(1)},${(b.y + b.r * 0.62 * Math.sin(0.35)).toFixed(1)} A${(b.r * 0.62).toFixed(1)},${(b.r * 0.62).toFixed(1)} 0 0 1 ${(b.x + b.r * 0.62 * Math.cos(1.9)).toFixed(1)},${(b.y + b.r * 0.62 * Math.sin(1.9)).toFixed(1)}`} />
                </g>
            ))}
        </g>
    )
}

const seeded = (key: string, n: number) => {
    let h = 2166136261
    for (const ch of key + n) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
    return h / 4294967295
}

function Tree({ g, t, upto, selected, onSelect, who, box, people }: {
    g: Graph; t: Grown; upto: number; selected: string | null; onSelect: (sha: string) => void; who: string | null; box: HTMLDivElement | null; people: PersonLite[]
})
{
    const { limbs, at, cx, width, height, groundY, bySha, index, ROW } = t
    const seen = (sha: string) => (index.get(sha) ?? 0) <= upto

    useEffect(() => {
        if (!box) return
        if (width > box.clientWidth) box.scrollLeft = cx - box.clientWidth / 2
    }, [box, g, width, cx])

    useEffect(() => {
        if (!box || !selected || !at.has(selected)) return
        const p = at.get(selected)!
        const pad = 140
        if (p.y < box.scrollTop + pad || p.y > box.scrollTop + box.clientHeight - pad) box.scrollTo({ top: p.y - box.clientHeight / 2, behavior: 'smooth' })
    }, [selected, box, at])

    const trunk = limbs[0]!
    const trunkVisible = trunk.commits.filter(seen)
    const trunkPts: Pt[] = [[cx, groundY + 4], ...trunkVisible.map((s) => [at.get(s)!.x, at.get(s)!.y] as Pt)]
    const trunkBase = Math.min(48, 26 + trunk.commits.length * 1.5)
    const trunkW = (u: number) => 5 + (trunkBase - 5) * (1 - u) ** 0.85 + 14 * Math.max(0, 1 - u * 9) ** 2
    const github = (email: string) => people.find((p) => p.email.toLowerCase() === email.toLowerCase())?.github ?? null
    const dateEvery = Math.max(1, Math.round(150 / ROW))
    const months = new Set<string>()
    const live = (l: Limb) => l.id !== 0 && (l.open || !l.mergeInto || !seen(l.mergeInto))

    return (
        <svg className="tree-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Commit tree for ${g.repo}`}>
            <defs>
                <linearGradient id="tree-ground" x1="0" x2="1"><stop offset="0" className="ground-stop" stopOpacity="0" /><stop offset="0.5" className="ground-stop" stopOpacity="1" /><stop offset="1" className="ground-stop" stopOpacity="0" /></linearGradient>
            </defs>

            {t.asc.map((c, i) => {
                const month = c.date.slice(0, 7)
                const show = i % dateEvery === 0 || !months.has(month)
                months.add(month)
                if (!show || i > upto) return null
                const y = groundY - 36 - i * ROW
                return (
                    <g key={c.sha} className="t-time">
                        <line x1={box ? box.scrollLeft + 76 : 76} x2={width} y1={y} y2={y} />
                        <text x={box ? box.scrollLeft + 24 : 24} y={y + 4}>{new Date(c.date).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}</text>
                    </g>
                )
            })}

            {/* Ground: one hairline and a few fine roots. */}
            <line x1={cx - 240} x2={cx + 240} y1={groundY + 2} y2={groundY + 2} stroke="url(#tree-ground)" strokeWidth={1} />
            {[-1, 1].map((d) => [0, 1].map((r) => (
                <Wood key={`${d}${r}`} className="root" rings={false} geo={limbGeo([[cx + d * 4, groundY - 6], [cx + d * (34 + r * 36), groundY + 14 + r * 8]], (u) => (9 - r * 3.5) * (1 - u) + 1.2, false)} />
            )))}

            {/* The crown, behind the wood: fuller over live work, faint over merged work. */}
            <Crown kind="old" clusters={limbs.filter((l) => l.id !== 0 && !live(l) && l.commits.some(seen)).map((l) => { const p = at.get(l.commits.filter(seen).at(-1)!)!; return { key: `o${l.id}`, x: p.x + l.side * 6, y: p.y - 8, r: 26 } })} />
            <Crown kind="live" clusters={[
                ...(trunkVisible.length ? [(() => { const p = at.get(trunkVisible.at(-1)!)!; return { key: 'crown', x: p.x, y: p.y - 34, r: 96 } })()] : []),
                ...limbs.filter((l) => live(l) && l.commits.some(seen)).flatMap((l) => {
                    const vis = l.commits.filter(seen)
                    const tip = at.get(vis.at(-1)!)!
                    const mid = at.get(vis[Math.floor(vis.length / 2)]!)!
                    return [{ key: `t${l.id}`, x: tip.x + l.side * 8, y: tip.y - 14, r: 40 }, ...(vis.length > 2 ? [{ key: `m${l.id}`, x: mid.x + l.side * 18, y: mid.y, r: 26 }] : [])]
                }),
            ]} />

            {/* Grafts: merged work joining back. */}
            {limbs.slice(1).filter((l) => l.mergeInto && at.has(l.mergeInto) && seen(l.mergeInto)).map((l) => {
                const tip = at.get(l.commits.at(-1)!)!
                const into = at.get(l.mergeInto!)!
                return <path key={`m${l.id}`} className="t-graft" d={limbPath([[tip.x, tip.y], [into.x, into.y]], () => 1.8, false)} />
            })}

            {/* Branches, then the trunk over their bases. */}
            {limbs.slice(1).map((l) => {
                const vis = l.commits.filter(seen)
                if (!vis.length) return null
                const base = l.fork && at.has(l.fork) ? at.get(l.fork)! : at.get(l.commits[0]!)!
                const pts: Pt[] = [[base.x, base.y], ...vis.map((s) => [at.get(s)!.x, at.get(s)!.y] as Pt)]
                const thick = 7 + Math.min(l.commits.length, 8) * 1.3
                return <Wood key={l.id} className={`grow ${live(l) ? 'live' : 'old'}`} geo={limbGeo(pts, (u) => 2 + (thick - 2) * (1 - u) ** 0.9, true)} />
            })}
            <Wood className="grow trunk live" geo={limbGeo(trunkPts, trunkW, false)} />


            {/* One bud per commit. */}
            {limbs.map((l) => l.commits.filter(seen).map((sha) => {
                const p = at.get(sha)!
                const c = bySha.get(sha)!
                const kind = l.id === 0 ? 'trunk' : live(l) ? 'open' : 'merged'
                return (
                    <g key={sha} className={`t-node ${kind} ${selected === sha ? 'on' : ''} ${who && c.email !== who ? 'dim' : ''}`} onClick={() => onSelect(sha)}>
                        <title>{`${c.subject}\n${c.author} · ${new Date(c.date).toLocaleString('en-ZA')}`}</title>
                        <circle className="t-halo" cx={p.x} cy={p.y} r={16} />
                        <circle className="t-ring" cx={p.x} cy={p.y} r={10.5} />
                        <SvgFace id={`face-${sha}`} x={p.x} y={p.y} r={9} name={c.author} email={c.email} github={github(c.email)} />
                        <circle cx={p.x} cy={p.y} r={14} fill="transparent" />
                    </g>
                )
            }))}

            {/* Labelled links: where merged work joined back. */}
            {limbs.slice(1).filter((l) => l.mergeInto && at.has(l.mergeInto) && seen(l.mergeInto)).map((l) => {
                const tip = at.get(l.commits.at(-1)!)!
                const into = at.get(l.mergeInto!)!
                return <text key={`ml${l.id}`} className="t-link" x={(tip.x + into.x) / 2 + l.side * 8} y={(tip.y + into.y) / 2 - 4} textAnchor={l.side === 1 ? 'start' : 'end'}>merged{l.pr ? ` ${l.pr}` : ''}</text>
            })}

            {/* The map: an idea card per branch, a label per commit. */}
            {(() => {
                const taken: { x: number; y: number; w: number; h: number }[] = []
                const free = (r: { x: number; y: number; w: number; h: number }) => !taken.some((o) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h)
                for (const l of limbs) for (const sha of l.commits.filter(seen)) { const p = at.get(sha)!; taken.push({ x: p.x - 11, y: p.y - 11, w: 22, h: 22 }) }
                const out: ReactNode[] = []
                const tips = new Set<string>()
                for (const l of limbs) {
                    const vis = l.commits.filter(seen)
                    if (!vis.length) continue
                    const tipSha = vis.at(-1)!
                    const tip = at.get(tipSha)!
                    const w = l.id === 0 ? Math.max(120, (t.limbs[0]!.name.length + 6) * 7.4) : tagWidth(l)
                    const h = 40
                    const side = l.id === 0 ? 0 : l.side
                    const x = side === 0 ? tip.x - w / 2 : side === 1 ? tip.x + 22 : tip.x - 22 - w
                    const y = side === 0 ? tip.y - 70 : tip.y - h / 2
                    if (l.id !== 0) tips.add(tipSha)
                    taken.push({ x, y, w, h })
                    const kind = l.id === 0 ? 'trunk' : live(l) ? 'open' : 'merged'
                    out.push(
                        <g key={`card${l.id}`} className={`t-card ${kind}`} onClick={() => onSelect(tipSha)}>
                            <title>{l.name}</title>
                            {side !== 0 ? <line className="t-card-link" x1={tip.x + side * 11} y1={tip.y} x2={side === 1 ? x : x + w} y2={tip.y} /> : <line className="t-card-link" x1={tip.x} y1={tip.y - 11} x2={tip.x} y2={y + h} />}
                            <rect x={x} y={y} width={w} height={h} rx={10} />
                            {l.id === 0 ? (
                                <>
                                    <text className="t-card-title" x={x + w / 2} y={y + 17} textAnchor="middle">{l.name}</text>
                                    <text className="t-card-sub" x={x + w / 2} y={y + 31} textAnchor="middle">trunk · {l.commits.length} commits</text>
                                </>
                            ) : (
                                <>
                                    <circle className="t-card-dot" cx={x + 14} cy={y + 13} r={3.2} />
                                    <text className="t-card-title" x={x + 23} y={y + 18}>{cardTitle(l)}</text>
                                    <text className="t-card-sub" x={x + 13} y={y + 32}>{cardSub(l)}</text>
                                </>
                            )}
                        </g>,
                    )
                }
                // Commit labels, newest first so recent work wins any tight spot.
                const order = limbs.flatMap((l) => l.commits.filter(seen).map((sha) => ({ l, sha }))).sort((a, b) => (index.get(b.sha) ?? 0) - (index.get(a.sha) ?? 0))
                for (const { l, sha } of order) {
                    if (tips.has(sha)) continue
                    const p = at.get(sha)!
                    const text = clip(plain(bySha.get(sha)!.subject), LABEL)
                    const w = text.length * 6.1
                    const sides: (1 | -1)[] = l.id === 0 ? [-1, 1] : [l.side]
                    for (const sd of sides) {
                        const r = { x: sd === 1 ? p.x + 15 : p.x - 15 - w, y: p.y - 8, w, h: 15 }
                        if (!free(r)) continue
                        taken.push(r)
                        out.push(<text key={`lbl${sha}`} className={`t-label ${who && bySha.get(sha)!.email !== who ? 'dim' : ''} ${selected === sha ? 'on' : ''}`} x={sd === 1 ? p.x + 15 : p.x - 15} y={p.y + 4} textAnchor={sd === 1 ? 'start' : 'end'} onClick={() => onSelect(sha)}>{text}</text>)
                        break
                    }
                }
                return out
            })()}
        </svg>
    )
}
// ---- What changed, and the code as it was ----

function DiffView({ patch, path }: { patch: string; path: string })
{
    const section = useMemo(() => {
        const parts = patch.split(/^diff --git /m).slice(1)
        const hit = parts.find((p) => p.startsWith(`a/${path} `) || p.includes(` b/${path}\n`))
        return hit ? hit.split('\n').slice(1).filter((l) => !/^(index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l)) : []
    }, [patch, path])
    if (!section.length) return <div className="empty small">No line changes to show for this file.</div>
    return (
        <pre className="code-view diff">
            {section.map((l, i) => (
                <div key={i} className={l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>{l || ' '}</div>
            ))}
        </pre>
    )
}

function CodeAt({ repo, sha, prefer }: { repo: string; sha: string; prefer: string | null })
{
    const q = `repo=${encodeURIComponent(repo)}&sha=${sha}`
    const files = useApi<{ files: string[] }>(`/api/code/files?${q}`)
    const [path, setPath] = useState<string | null>(null)
    const [filter, setFilter] = useState('')
    useEffect(() => {
        const list = files.data?.files ?? []
        if (!list.length) return
        setPath((cur) => (cur && list.includes(cur) ? cur : prefer && list.includes(prefer) ? prefer : list.find((f) => /readme/i.test(f)) ?? list[0]!))
    }, [files.data, prefer])
    const file = useApi<FileAt>(path ? `/api/code/file?${q}&path=${encodeURIComponent(path)}` : null)
    const shown = (files.data?.files ?? []).filter((f) => f.toLowerCase().includes(filter.toLowerCase()))
    return (
        <div className="code-at">
            <div className="code-files">
                <input className="input" placeholder={`Filter ${files.data?.files.length ?? ''} files`} value={filter} onChange={(e) => setFilter(e.target.value)} />
                <ul>
                    {shown.slice(0, 300).map((f) => (
                        <li key={f}><button className={f === path ? 'on' : ''} onClick={() => setPath(f)}>{f}</button></li>
                    ))}
                </ul>
            </div>
            <div className="code-file">
                {file.data ? (
                    <>
                        <div className="code-file-head mono">{file.data.path}<span className="faint"> · {(file.data.size / 1024).toFixed(1)} kB</span></div>
                        {file.data.binary ? <div className="empty small">A binary file.</div> : (
                            <pre className="code-view numbered">
                                {file.data.content.replace(/\n$/, '').split('\n').map((line, i) => <div key={i}><span>{i + 1}</span>{line || ' '}</div>)}
                            </pre>
                        )}
                        {file.data.truncated ? <div className="empty small">Showing the first 200 kB.</div> : null}
                    </>
                ) : <div className="empty small">{file.error ?? 'Opening…'}</div>}
            </div>
        </div>
    )
}

/** The app as it was at one commit, served from the VM. */
function PreviewFrame({ repo, sha }: { repo: string; sha: string })
{
    const p = useApi<Preview>(`/api/code/preview?repo=${encodeURIComponent(repo)}&sha=${sha}`)
    const [shown, setShown] = useState<string | null>(null)
    useEffect(() => { if (p.data?.url) setShown(p.data.url) }, [p.data?.url])
    if (p.error) return <div className="preview-empty">The preview isn't available on this server yet.<span className="small faint">{p.error}</span></div>
    if (p.data && !p.data.url) return <div className="preview-empty">Nothing to show at this commit.<span className="small faint">{p.data.reason ?? 'There is no index.html at this point in history.'}</span></div>
    return shown
        ? <iframe key={shown} className="preview-frame" src={shown} title={`The app at ${sha.slice(0, 7)}`} sandbox="allow-scripts allow-forms allow-modals allow-popups" />
        : <div className="preview-empty">Starting the app at this commit…</div>
}

// ---- The side panel: recent changes in plain words, and the people behind them ----

interface Explanation { summary: string; review: string[]; model: string | null }
const notesCache = new Map<string, Explanation>()

/** The agent's plain-words note on a commit (or a whole branch), fetched once and kept. */
function useNotes(repo: string, key: string | null, body: Record<string, unknown> | null)
{
    const [state, setState] = useState<{ key: string; e: Explanation | null; error: string | null } | null>(null)
    useEffect(() => {
        if (!key || !body) return
        const k = `${repo}:${key}`
        const hit = notesCache.get(k)
        if (hit) { setState({ key, e: hit, error: null }); return }
        let live = true
        setState({ key, e: null, error: null })
        const timer = setTimeout(() => {
            api<Explanation>(`/api/code/explain?repo=${encodeURIComponent(repo)}`, { body })
                .then((e) => { notesCache.set(k, e); if (live) setState({ key, e, error: null }) })
                .catch((err: Error) => live && setState({ key, e: null, error: err.message }))
        }, 250)
        return () => { live = false; clearTimeout(timer) }
    }, [repo, key])
    return state && state.key === key ? state : null
}

function Notes({ notes }: { notes: ReturnType<typeof useNotes> })
{
    if (!notes || (!notes.e && !notes.error)) return <div className="notes-loading"><i /><i /><i /></div>
    if (notes.error) return <p className="small faint">Couldn't write a note for this one: {notes.error}</p>
    const e = notes.e!
    return (
        <div className="notes">
            <p>{e.summary}</p>
            {e.review.length ? (
                <>
                    <div className="notes-label">Worth a look</div>
                    <ul>{e.review.map((r) => <li key={r}>{r}</li>)}</ul>
                </>
            ) : null}
            <div className="notes-by">{e.model ? `Written by ${e.model} on Vultr` : 'Written from the commit itself'}</div>
        </div>
    )
}

const areaOf = (path: string) => {
    const parts = path.split('/')
    return parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts.length === 2 ? parts[0]! : 'the root folder'
}

function CodeDialog({ repo, sha, detail, onClose }: { repo: string; sha: string; detail: CommitDetail | null; onClose: () => void })
{
    const [tab, setTab] = useState<'changes' | 'code'>('changes')
    const [file, setFile] = useState<string | null>(null)
    const current = file ?? detail?.files[0]?.path ?? null
    return (
        <Dialog title={`Code at ${sha.slice(0, 7)}`} onClose={onClose} wide>
            <div className="seg">
                <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>What changed</button>
                <button className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>All files at this point</button>
            </div>
            {tab === 'changes' && detail ? (
                <>
                    <ul className="changed">
                        {detail.files.map((f) => (
                            <li key={f.path}>
                                <button className={f.path === current ? 'on' : ''} onClick={() => setFile(f.path)}>
                                    <span className="mono ellipsis">{f.path}</span>
                                    <span className="mono"><span className="add-n">+{f.added ?? '?'}</span> <span className="del-n">−{f.removed ?? '?'}</span></span>
                                </button>
                            </li>
                        ))}
                    </ul>
                    {current ? <DiffView patch={detail.patch} path={current} /> : null}
                </>
            ) : <CodeAt repo={repo} sha={sha} prefer={current} />}
        </Dialog>
    )
}

function ChangeRow({ c, branch, on, onPick, people }: { c: Commit; branch?: string; on?: boolean; onPick: () => void; people: PersonLite[] })
{
    const person = people.find((p) => p.email.toLowerCase() === c.email.toLowerCase())
    return (
        <li>
            <button className={`change-row ${on ? 'on' : ''}`} onClick={onPick}>
                <Avatar name={c.author} email={c.email} github={person?.github} size={24} />
                <span className="change-text">
                    <span className="ellipsis">{plain(c.subject)}</span>
                    <span className="small faint ellipsis">{branch ? <><span className="mono">{branch}</span> · </> : null}{c.author.split(' ')[0]} · {ago(c.date)}</span>
                </span>
            </button>
        </li>
    )
}

function CommitView({ repo, sha, t, people, onSelect, onBack, onWatch, onView }: {
    repo: string; sha: string; t: Grown; people: PersonLite[]; onSelect: (s: string) => void; onBack: () => void; onWatch: () => void; onView: () => void
})
{
    const detail = useApi<CommitDetail>(`/api/code/commit?repo=${encodeURIComponent(repo)}&sha=${sha}`)
    const d = detail.data?.commit.sha === sha ? detail.data : null
    const limb = t.limbs[t.at.get(sha)?.limb ?? -1]
    const c = t.bySha.get(sha)
    const person = people.find((p) => p.email.toLowerCase() === c?.email.toLowerCase())
    const notes = useNotes(repo, sha, { sha })
    const branch = limb && limb.id !== 0 && limb.fork ? limb : null
    const [askBranch, setAskBranch] = useState(false)
    useEffect(() => setAskBranch(false), [branch?.id])
    const branchNotes = useNotes(repo, askBranch && branch ? `branch:${branch.name}:${branch.commits.at(-1)}` : null, branch ? { sha: branch.commits.at(-1), base: branch.fork, branch: branch.name } : null)
    const [code, setCode] = useState(false)
    const areas = d ? [...new Set(d.files.map((f) => areaOf(f.path)))] : []
    const added = d ? d.files.reduce((n, f) => n + (f.added ?? 0), 0) : 0
    const removed = d ? d.files.reduce((n, f) => n + (f.removed ?? 0), 0) : 0
    const recent = limb ? [...limb.commits].reverse().slice(0, 6).map((s) => t.bySha.get(s)!) : []

    return (
        <>
            <div className="panel-head">
                <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                    <button className="btn ghost sm back" onClick={onBack}><Icon.back /> Overview</button>
                    <span className="mono faint small" style={{ marginLeft: 'auto' }}>{sha.slice(0, 7)}</span>
                </div>
                {limb ? <div style={{ marginTop: 12 }}><Pill tone={limb.id === 0 ? 'accent' : limb.open ? 'good' : 'neutral'}>{limb.name}{limb.id !== 0 && !limb.open ? ' · merged' : ''}</Pill></div> : null}
                <h2>{c?.subject}</h2>
                {c ? (
                    <div className="drawer-who">
                        <Avatar name={c.author} email={c.email} github={person?.github} size={22} />
                        {person ? <Link to={`/team/${person.id}`}>{c.author}</Link> : <span>{c.author}</span>}
                        <span className="faint">· {ago(c.date)}</span>
                    </div>
                ) : null}
                <div className="drawer-actions">
                    <button className="btn primary sm" onClick={onView}><Icon.eye /> View app</button>
                    <button className="btn sm" onClick={onWatch}><Icon.play /> Watch it grow</button>
                </div>
            </div>

            <section className="panel-section">
                <h3>What changed</h3>
                <Notes notes={notes} />
                {d ? (
                    <div className="change-facts">
                        <span><b>{d.files.length}</b> {d.files.length === 1 ? 'file' : 'files'}</span>
                        <span className="add-n">+{added}</span>
                        <span className="del-n">−{removed}</span>
                        <span className="faint ellipsis">in {areas.slice(0, 3).join(', ')}{areas.length > 3 ? ` and ${areas.length - 3} more` : ''}</span>
                    </div>
                ) : null}
                <button className="link-btn" onClick={() => setCode(true)}>Code at this point →</button>
            </section>

            <AskAgent repo={repo} sha={sha} scope="this commit" />

            {branch ? (
                <section className="panel-section">
                    <h3>The branch so far</h3>
                    {askBranch ? <Notes notes={branchNotes} /> : <button className="btn sm" onClick={() => setAskBranch(true)}><Icon.spark /> Explain branch</button>}
                </section>
            ) : null}

            {recent.length > 1 ? (
                <section className="panel-section">
                    <h3>Recent on {limb ? (limb.id === 0 ? limb.name : human(limb.name).toLowerCase()) : 'this branch'}</h3>
                    <ul className="changes">
                        {recent.map((r) => <ChangeRow key={r.sha} c={r} on={r.sha === sha} onPick={() => onSelect(r.sha)} people={people} />)}
                    </ul>
                </section>
            ) : null}
            {code ? createPortal(<CodeDialog repo={repo} sha={sha} detail={d} onClose={() => setCode(false)} />, document.body) : null}
        </>
    )
}

// ---- Ask the agent: an OpenAI-compatible model that reads the code at this point ----

interface Turn { role: 'user' | 'assistant'; content: string; model?: string | null }

function AskAgent({ repo, sha, scope }: { repo: string; sha: string; scope: string })
{
    const [turns, setTurns] = useState<Turn[]>([])
    const [q, setQ] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const end = useRef<HTMLDivElement>(null)
    useEffect(() => { setTurns([]); setError(null) }, [sha])
    useEffect(() => { end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [turns, busy])
    const ask = async (question: string) => {
        const text = question.trim()
        if (!text || busy) return
        const history = turns.map(({ role, content }) => ({ role, content }))
        setTurns((ts) => [...ts, { role: 'user', content: text }])
        setQ('')
        setBusy(true)
        setError(null)
        try {
            const r = await api<{ answer: string; model: string | null }>(`/api/code/ask?repo=${encodeURIComponent(repo)}`, { body: { sha, question: text, history } })
            setTurns((ts) => [...ts, { role: 'assistant', content: r.answer, model: r.model }])
        } catch (e) {
            const status = (e as { status?: number }).status
            setError(status === 404 ? "The agent isn't connected on this server yet." : (e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    const starters = ['What does this do, in plain words?', 'Anything risky here?', 'How should we test it?']
    return (
        <section className="panel-section ask">
            <h3>Ask the agent</h3>
            {turns.length ? (
                <div className="ask-thread">
                    {turns.map((t, i) => (
                        <div key={i} className={`ask-turn ${t.role}`}>
                            {t.role === 'assistant' ? <span className="ask-mark"><Icon.spark /></span> : null}
                            <div>
                                <p>{t.content}</p>
                                {t.role === 'assistant' ? <div className="notes-by">{t.model ? `${t.model}, OpenAI-compatible, on Vultr` : 'Answered from the facts, no model connected'}</div> : null}
                            </div>
                        </div>
                    ))}
                    {busy ? <div className="ask-turn assistant"><span className="ask-mark"><Icon.spark /></span><div className="notes-loading" style={{ flex: 1 }}><i /><i /></div></div> : null}
                    <div ref={end} />
                </div>
            ) : (
                <div className="ask-starters">
                    {starters.map((s) => <button key={s} className="chip" onClick={() => void ask(s)} disabled={busy}>{s}</button>)}
                </div>
            )}
            {error ? <p className="small" style={{ color: 'var(--critical)', marginTop: 8 }}>{error}</p> : null}
            <form className="ask-box" onSubmit={(e) => { e.preventDefault(); void ask(q) }}>
                <input className="input" placeholder={`Ask about ${scope}…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Ask the agent" />
                <button className="btn primary sm icon-only round" disabled={busy || !q.trim()} aria-label="Send"><Icon.up /></button>
            </form>
        </section>
    )
}

function Overview({ repo, t, project, people, onSelect }: { repo: string; t: Grown; project: RepoRow | undefined; people: PersonLite[]; onSelect: (s: string) => void })
{
    const recent = [...t.asc].reverse().slice(0, 8)
    const week = t.asc.filter((c) => Date.now() - new Date(c.date).getTime() < 7 * 86_400_000)
    const weekPeople = new Set(week.map((c) => c.email)).size
    const weekBranches = new Set(week.map((c) => t.at.get(c.sha)?.limb)).size
    const live = t.limbs.filter((l) => l.id !== 0 && l.open)
    return (
        <>
            <div className="panel-head">
                <div className="small faint">{project?.client || 'Project'}</div>
                <h2 style={{ marginTop: 4 }}>{project?.project ?? t.limbs[0]?.name}</h2>
                <p className="panel-lede">
                    {week.length
                        ? `${week.length} ${week.length === 1 ? 'change' : 'changes'} this week by ${weekPeople} ${weekPeople === 1 ? 'person' : 'people'} across ${weekBranches} ${weekBranches === 1 ? 'branch' : 'branches'}.`
                        : `Quiet this week. The last change was ${ago(recent[0]!.date)}.`}
                    {live.length ? ` ${live.length} ${live.length === 1 ? 'branch is' : 'branches are'} still growing.` : ' Everything is merged.'}
                </p>
                {project?.reasons?.length ? <div className={`panel-flag ${project.health}`}><span className={`health ${project.health}`} />{project.reasons.join(' · ')}</div> : null}
            </div>
            <section className="panel-section">
                <h3>Recent changes</h3>
                <ul className="changes">
                    {recent.map((c) => <ChangeRow key={c.sha} c={c} branch={short(t.limbs[t.at.get(c.sha)?.limb ?? 0]?.name ?? '')} onPick={() => onSelect(c.sha)} people={people} />)}
                </ul>
                <p className="small faint" style={{ marginTop: 10 }}>Tap any change, or any face on the tree, to read what it did.</p>
            </section>
            <AskAgent repo={repo} sha={t.limbs[0]!.commits.at(-1)!} scope={`${project?.project ?? 'this project'} as it is now`} />
        </>
    )
}

function Contributors({ commits, who, onPick, people }: { commits: Commit[]; who: string | null; onPick: (email: string | null) => void; people: PersonLite[] })
{
    const [all, setAll] = useState(false)
    const list = useMemo(() => {
        const by = new Map<string, { name: string; email: string; count: number; last: string }>()
        for (const c of commits) {
            const p = by.get(c.email) ?? { name: c.author, email: c.email, count: 0, last: c.date }
            p.count++
            if (c.date > p.last) p.last = c.date
            by.set(c.email, p)
        }
        return [...by.values()].sort((a, b) => b.count - a.count)
    }, [commits])
    const find = (email: string) => people.find((p) => p.email.toLowerCase() === email.toLowerCase())
    const shown = all ? list : list.slice(0, 5)
    return (
        <section className="panel-people">
            <div className="spread">
                <h3>Contributors <span className="faint">{list.length}</span></h3>
                {who ? <button className="link-btn" onClick={() => onPick(null)}>Show everyone</button> : null}
            </div>
            <ul>
                {shown.map((p) => {
                    const person = find(p.email)
                    return (
                        <li key={p.email} className={`${who === p.email ? 'on' : ''} ${who && who !== p.email ? 'dim' : ''}`}>
                            <button className="person-row" onClick={() => onPick(who === p.email ? null : p.email)} aria-pressed={who === p.email} title="Light up their work on the tree">
                                <Avatar name={p.name} email={p.email} github={person?.github} size={32} />
                                <span className="change-text">
                                    <b className="ellipsis">{p.name}</b>
                                    <span className="small faint">{p.count} {p.count === 1 ? 'commit' : 'commits'} · last {ago(p.last)}</span>
                                </span>
                            </button>
                            {person ? <Link className="profile-arrow" to={`/team/${person.id}`} aria-label={`${p.name}'s profile`} title="Profile"><Icon.chev /></Link> : null}
                        </li>
                    )
                })}
            </ul>
            {list.length > 5 ? <button className="link-btn" onClick={() => setAll((a) => !a)}>{all ? 'Show fewer' : `Show all ${list.length}`}</button> : null}
        </section>
    )
}
// ---- Playback: watch the code grow, commit by commit ----

interface Playback { seq: string[]; pos: number; playing: boolean; label: string }

function Scrubber({ pb, t, onPos, onPlay, onClose, onView }: { pb: Playback; t: Grown; onPos: (n: number) => void; onPlay: (p: boolean) => void; onClose: () => void; onView?: () => void })
{
    const c = t.bySha.get(pb.seq[pb.pos]!)
    return (
        <div className="scrubber" role="group" aria-label="Playback">
            <button className="btn ghost sm icon-only" onClick={() => onPos(Math.max(0, pb.pos - 1))} aria-label="Previous commit"><Icon.prev /></button>
            <button className="btn primary sm icon-only round" onClick={() => onPlay(!pb.playing)} aria-label={pb.playing ? 'Pause' : 'Play'}>{pb.playing ? <Icon.pause /> : <Icon.play />}</button>
            <button className="btn ghost sm icon-only" onClick={() => onPos(Math.min(pb.seq.length - 1, pb.pos + 1))} aria-label="Next commit"><Icon.next /></button>
            <div className="scrub-track">
                <div className="scrub-meta">
                    <span className="ellipsis"><b>{pb.label}</b> <span className="faint">· {c?.subject}</span></span>
                    <span className="faint num">{pb.pos + 1} / {pb.seq.length}{c ? ` · ${new Date(c.date).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}` : ''}</span>
                </div>
                <input type="range" min={0} max={pb.seq.length - 1} value={pb.pos} onChange={(e) => onPos(Number(e.target.value))} aria-label="Commit" />
            </div>
            {onView ? <button className="btn sm" onClick={onView}><Icon.eye /> View</button> : null}
            <button className="btn ghost sm icon-only" onClick={onClose} aria-label="Stop"><Icon.x /></button>
        </div>
    )
}

function usePlayer(pb: Playback | null, setPb: (f: (p: Playback | null) => Playback | null) => void, ms: number)
{
    useEffect(() => {
        if (!pb?.playing) return
        const id = setTimeout(() => setPb((p) => (p ? (p.pos >= p.seq.length - 1 ? { ...p, playing: false } : { ...p, pos: p.pos + 1 }) : p)), ms)
        return () => clearTimeout(id)
    }, [pb, setPb, ms])
}

/** The app itself, full screen, with its history underneath to step through. */
function Viewer({ repo, t, seq, start, label, onClose }: { repo: string; t: Grown; seq: string[]; start: number; label: string; onClose: () => void })
{
    const [pb, setPb] = useState<Playback | null>({ seq, pos: start, playing: false, label })
    usePlayer(pb, setPb, 1600)
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])
    if (!pb) return null
    const sha = pb.seq[pb.pos]!
    return (
        <div className="viewer" role="dialog" aria-modal="true" aria-label="App preview">
            <div className="viewer-bar">
                <div className="browser-dots"><i /><i /><i /></div>
                <div className="viewer-url mono"><Icon.tree /> {label} @ {sha.slice(0, 7)}</div>
                <button className="btn ghost sm icon-only" onClick={onClose} aria-label="Close preview"><Icon.x /></button>
            </div>
            <div className="viewer-stage"><PreviewFrame repo={repo} sha={sha} /></div>
            <div className="viewer-foot">
                <Scrubber pb={pb} t={t} onPos={(n) => setPb((p) => p && { ...p, pos: n, playing: false })} onPlay={(v) => setPb((p) => p && { ...p, playing: v, pos: v && p.pos >= p.seq.length - 1 ? 0 : p.pos })} onClose={onClose} />
            </div>
        </div>
    )
}

// ---- Plant from GitHub: solo or a team, anyone's public repos become trees ----

interface GhRepo { full_name: string; description: string | null; language: string | null; pushed_at: string; fork: boolean; stargazers_count: number }

function GitHubPlanter({ planted, onPlanted }: { planted: string[]; onPlanted: (repo: string) => void })
{
    const { me, toast } = useStudio()
    const known = realLogin(me.githubLogin, me.email) ?? ''
    const [user, setUser] = useState(known)
    const [list, setList] = useState<GhRepo[] | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [manual, setManual] = useState('')
    const have = new Set(planted.map((r) => r.toLowerCase()))

    const load = async (u: string) => {
        const login = u.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '')
        if (!login) return
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}/repos?sort=pushed&per_page=40`)
            if (res.status === 404) throw new Error(`There's no GitHub account called ${login}.`)
            if (!res.ok) throw new Error('GitHub did not answer just now. Try again in a minute.')
            setList(((await res.json()) as GhRepo[]).filter((r) => !r.fork))
            // Remember it, so their face shows on their commits.
            if (login !== me.githubLogin) void api('/api/me', { method: 'PATCH', body: { githubLogin: login } }).then(announceChange).catch(() => {})
        } catch (e) {
            setError((e as Error).message)
            setList(null)
        } finally {
            setLoading(false)
        }
    }
    useEffect(() => { if (known) void load(known) }, [])

    const plant = async (repo: string) => {
        setBusy(repo)
        try {
            const r = await api<{ repo: string }>('/api/code/plant', { body: { repo } })
            announceChange()
            onPlanted(r.repo)
        } catch (e) {
            toast((e as Error).message, true)
        } finally {
            setBusy(null)
        }
    }

    if (me.role !== 'manager') return <p className="muted">Ask whoever runs your space to plant a repo. Then it grows here for the whole team.</p>
    return (
        <div className="planter">
            <form className="planter-row" onSubmit={(e) => { e.preventDefault(); void load(user) }}>
                <span className="planter-gh"><Icon.github /></span>
                <input className="input" placeholder="Your GitHub username" value={user} onChange={(e) => setUser(e.target.value)} aria-label="GitHub username" />
                <button className="btn primary" disabled={loading || !user.trim()}>{loading ? 'Looking…' : 'Show my repos'}</button>
            </form>
            {error ? <p className="small" style={{ color: 'var(--critical)' }}>{error}</p> : null}
            {list ? (
                list.length ? (
                    <ul className="planter-list">
                        {list.map((r) => {
                            const done = have.has(r.full_name.toLowerCase())
                            return (
                                <li key={r.full_name}>
                                    <div className="grow">
                                        <b className="mono">{r.full_name}</b>
                                        <span className="small faint ellipsis">{[r.language, r.description, `pushed ${ago(r.pushed_at)}`].filter(Boolean).join(' · ')}</span>
                                    </div>
                                    {done
                                        ? <button className="btn sm" onClick={() => onPlanted(r.full_name)}>Open tree</button>
                                        : <button className="btn sm primary" disabled={!!busy} onClick={() => void plant(r.full_name)}>{busy === r.full_name ? 'Planting…' : 'Plant'}</button>}
                                </li>
                            )
                        })}
                    </ul>
                ) : <p className="small faint">No public repos on that account yet.</p>
            ) : null}
            <form className="planter-row manual" onSubmit={(e) => { e.preventDefault(); if (manual.trim()) void plant(manual.trim()) }}>
                <input className="input" placeholder="Or paste any public repo: owner/name or a GitHub link" value={manual} onChange={(e) => setManual(e.target.value)} />
                <button className="btn" disabled={!!busy || !manual.trim()}>Plant</button>
            </form>
            <p className="small faint">Public repos only for now. Everyone in your space sees the trees you plant, so it works the same solo or as a team.</p>
        </div>
    )
}

// ---- Project switcher ----

function Switcher({ repos, repo, onPick }: { repos: RepoRow[]; repo: string | null; onPick: (repo: string) => void })
{
    const { me, toast } = useStudio()
    const [open, setOpen] = useState(false)
    const [planting, setPlanting] = useState(false)
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!open) return
        const off = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
        const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
        window.addEventListener('mousedown', off)
        window.addEventListener('keydown', esc)
        return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc) }
    }, [open])
    const cur = repos.find((r) => r.repo === repo)
    return (
        <div className="switcher" ref={ref}>
            <button className="switcher-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="listbox">
                <span className={`health ${cur?.health ?? 'none'}`} />
                <span className="switcher-name">
                    <b>{cur?.project ?? 'Choose a project'}</b>
                    <span className="small faint mono">{cur?.repo ?? ''}</span>
                </span>
                <Icon.down />
            </button>
            {open ? (
                <div className="switcher-menu" role="listbox">
                    <div className="menu-label">Projects</div>
                    {repos.map((r) => (
                        <button key={r.repo} role="option" aria-selected={r.repo === repo} className={r.repo === repo ? 'on' : ''} onClick={() => { setOpen(false); onPick(r.repo) }} title={r.reasons?.length ? r.reasons.join('\n') : 'All clear'}>
                            <span className={`health ${r.health ?? 'none'}`} />
                            <span className="switcher-name"><b>{r.project}</b><span className="small faint">{r.client || r.repo}</span></span>
                            {r.repo === repo ? <Icon.check /> : null}
                        </button>
                    ))}
                    {me.role === 'manager' ? (
                        <div className="plant">
                            <button className="btn sm block-left" onClick={() => { setOpen(false); setPlanting(true) }}><Icon.github /> Plant from GitHub…</button>
                        </div>
                    ) : null}
                </div>
            ) : null}
            {planting ? createPortal(
                <Dialog title="Plant a tree from GitHub" onClose={() => setPlanting(false)} wide>
                    <GitHubPlanter planted={repos.map((r) => r.repo)} onPlanted={(r) => { setPlanting(false); onPick(r) }} />
                </Dialog>,
                document.body,
            ) : null}
        </div>
    )
}

// ---- The page: the whole screen is the tree ----

export function CodeTree()
{
    const [params, setParams] = useSearchParams()
    const list = useApi<{ enabled: boolean; repos: RepoRow[] }>('/api/code')
    const peopleApi = useApi<{ people: PersonLite[] }>('/api/code/people')
    const people = peopleApi.data?.people ?? []
    const repos = list.data?.repos ?? []
    const repo = params.get('repo') ?? (repos.find((r) => r.repo === 'demo-studio/tidepool-booking') ?? repos[0])?.repo ?? null
    const graph = useApi<Graph>(repo ? `/api/code/graph?repo=${encodeURIComponent(repo)}` : null)
    const [selected, setSelected] = useState<string | null>(null)
    const [who, setWho] = useState<string | null>(null)
    const [pb, setPb] = useState<Playback | null>(null)
    const [view, setView] = useState<{ seq: string[]; start: number; label: string } | null>(null)
    const [box, setBox] = useState<HTMLDivElement | null>(null)
    const [size, setSize] = useState({ w: 0, h: 0 })
    const [panelOpen, setPanelOpen] = useState(() => { try { return localStorage.getItem('studio-panel') !== 'closed' } catch { return true } })
    const togglePanel = (open: boolean) => {
        setPanelOpen(open)
        try { localStorage.setItem('studio-panel', open ? 'open' : 'closed') } catch { /* fine for this visit */ }
    }

    useEffect(() => {
        if (!box) return
        const ro = new ResizeObserver(() => setSize({ w: box.clientWidth, h: box.clientHeight }))
        ro.observe(box)
        return () => ro.disconnect()
    }, [box])

    const t = useMemo(() => (graph.data && graph.data.commits.length ? grow(graph.data, size.w, size.h) : null), [graph.data, size.w, size.h])

    useEffect(() => {
        const asked = params.get('sha')
        if (graph.data && asked && graph.data.commits.some((c) => c.sha === asked)) setSelected(asked)
        else if (selected && graph.data && !graph.data.commits.some((c) => c.sha === selected)) setSelected(null)
    }, [graph.data])

    usePlayer(pb, setPb, pb && pb.seq.length > 40 ? 160 : 650)

    const playing = pb ? pb.seq[pb.pos]! : null
    const upto = t && playing ? t.index.get(playing) ?? Infinity : Infinity
    const shown = playing && pb?.label !== 'Whole history' ? playing : selected

    const pick = useCallback((r: string) => { setSelected(null); setWho(null); setPb(null); setParams({ repo: r }) }, [setParams])

    const labelOf = (sha: string) => (t ? t.limbs[t.at.get(sha)?.limb ?? 0]?.name ?? '' : '')
    const watch = (sha: string) => {
        if (!t) return
        const seq = lineage(t, sha)
        const limb = t.limbs[t.at.get(sha)?.limb ?? 0]
        const from = limb && limb.fork ? Math.max(0, seq.indexOf(limb.fork)) : 0
        setPb({ seq, pos: from, playing: true, label: labelOf(sha) })
    }
    const replayAll = () => t && setPb({ seq: t.asc.map((c) => c.sha), pos: 0, playing: true, label: 'Whole history' })
    const openView = (sha: string) => {
        if (!t) return
        const seq = lineage(t, sha)
        setView({ seq, start: seq.length - 1, label: labelOf(sha) })
    }

    const project = repos.find((r) => r.repo === repo)
    const openBranches = t ? t.limbs.filter((l) => l.id !== 0 && l.open).length : 0
    const merged = t ? t.limbs.filter((l) => !l.open).length : 0

    let body: ReactNode = null
    if (list.data && !list.data.enabled) body = <Hint title="The code tree is off">The server needs git installed to keep repos on its disk.</Hint>
    else if (list.data && !repos.length) body = (
        <div className="tree-hint plant-first">
            <Icon.tree />
            <strong>Plant your first tree</strong>
            <span>Connect your GitHub and pick a repo. Every commit becomes part of a living tree you can watch grow.</span>
            <div className="plant-card"><GitHubPlanter planted={[]} onPlanted={pick} /></div>
        </div>
    )
    else if (repo && graph.error) body = <Hint title="Could not read this repo">{graph.error}</Hint>
    else if (graph.data && !graph.data.commits.length) body = <Hint title="No commits yet">Push a first commit and the tree starts growing.</Hint>
    else if (!t) body = <Hint title="Growing the tree…" />

    return (
        <div className={`tree-page ${t && panelOpen ? 'has-drawer' : ''} ${shown ? 'picked' : ''}`}>
            <div className="tree-canvas" ref={setBox}>
                {t && graph.data ? <Tree g={graph.data} t={t} upto={upto} selected={shown} onSelect={(s) => { setPb(null); setSelected(s); togglePanel(true) }} who={who} box={box} people={people} /> : null}
            </div>
            {body}

            <header className="tree-top">
                <Switcher repos={repos} repo={repo} onPick={pick} />
                {t && graph.data ? (
                    <div className="tree-stats">
                        <span><b className="num">{graph.data.commits.length}</b> commits</span>
                        <span><i className="key open" /><b className="num">{openBranches}</b> open</span>
                        <span><i className="key merged" /><b className="num">{merged}</b> merged</span>
                        {project?.reasons?.length ? <span className={`tree-flag ${project.health}`} title={project.reasons.join('\n')}><span className={`health ${project.health}`} />{project.reasons[0]}</span> : null}
                    </div>
                ) : null}
                <div className="tree-tools">
                    {graph.data?.fetchedAt ? <span className="small faint hide-sm">Synced {ago(graph.data.fetchedAt)}</span> : null}
                    <button className="btn ghost sm icon-only" onClick={graph.reload} aria-label="Refresh" title="Refresh"><Icon.refresh /></button>
                    {t ? <button className="btn sm" onClick={replayAll}><Icon.play /> Replay</button> : null}
                    {t ? <button className={`btn ghost sm icon-only panel-toggle ${panelOpen ? 'on' : ''}`} onClick={() => togglePanel(!panelOpen)} aria-pressed={panelOpen} aria-label={panelOpen ? 'Hide the side panel' : 'Show the side panel'} title={panelOpen ? 'Hide the side panel' : 'Show the side panel'}><Icon.panel /></button> : null}
                </div>
            </header>

            {graph.data && t && pb ? (
                <footer className="tree-bottom">
                    <Scrubber
                        pb={pb}
                        t={t}
                        onPos={(n) => setPb((p) => p && { ...p, pos: n, playing: false })}
                        onPlay={(v) => setPb((p) => p && { ...p, playing: v, pos: v && p.pos >= p.seq.length - 1 ? 0 : p.pos })}
                        onClose={() => { if (pb.label !== 'Whole history') setSelected(pb.seq[pb.pos]!); setPb(null) }}
                        onView={() => { setView({ seq: pb.seq, start: pb.pos, label: pb.label }); setPb((p) => p && { ...p, playing: false }) }}
                    />
                </footer>
            ) : null}

            {repo && t && graph.data && panelOpen ? (
                <aside className={`tree-drawer panel ${shown ? 'has-commit' : ''}`} aria-label="Changes and people">
                    <button className="panel-collapse" onClick={() => togglePanel(false)} aria-label="Collapse the side panel" title="Collapse"><Icon.chev /></button>
                    <div className="panel-scroll">
                        {shown ? (
                            <CommitView
                                key={repo}
                                repo={repo}
                                sha={shown}
                                t={t}
                                people={people}
                                onSelect={(s) => { setPb(null); setSelected(s) }}
                                onBack={() => { setSelected(null); setPb(null) }}
                                onWatch={() => watch(shown)}
                                onView={() => openView(shown)}
                            />
                        ) : <Overview repo={repo} t={t} project={project} people={people} onSelect={(s) => setSelected(s)} />}
                    </div>
                    <Contributors commits={graph.data.commits} who={who} onPick={setWho} people={people} />
                </aside>
            ) : null}

            {view && repo && t ? <Viewer repo={repo} t={t} seq={view.seq} start={view.start} label={view.label} onClose={() => setView(null)} /> : null}
        </div>
    )
}

function Hint({ title, children }: { title: string; children?: ReactNode })
{
    return (
        <div className="tree-hint">
            <Icon.tree />
            <strong>{title}</strong>
            {children ? <span>{children}</span> : null}
        </div>
    )
}
