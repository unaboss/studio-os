// The agent explains a commit or a whole branch in plain words: what changed,
// why it matters, and what a reviewer should look at. With no model it still
// answers from the facts, so the button always works.
import { extractJson, type Inference } from './inference.ts'

export interface ChangeFacts
{
    readonly repo: string
    readonly kind: 'commit' | 'branch'
    /** The commit subject or the branch name. */
    readonly title: string
    readonly commits: readonly { subject: string; author: string; date: string }[]
    readonly files: readonly { path: string; added: number | null; removed: number | null }[]
    readonly patch: string
}

export interface Explanation
{
    readonly summary: string
    readonly review: readonly string[]
    /** The model that wrote it, or null for the plain version. */
    readonly model: string | null
}

const SENSITIVE = /auth|login|password|secret|token|payment|webhook|crypto|sign|migration|\.sql$|security|permission/i
const TESTS = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[jt]sx?$/

export function plainExplanation(f: ChangeFacts): Explanation
{
    const authors = [...new Set(f.commits.map((c) => c.author.split(' ')[0]))]
    const added = f.files.reduce((s, x) => s + (x.added ?? 0), 0)
    const removed = f.files.reduce((s, x) => s + (x.removed ?? 0), 0)
    const areas = [...new Set(f.files.map((x) => x.path.split('/').slice(0, -1).join('/') || 'the root'))].slice(0, 3)
    const who = authors.length > 1 ? `${authors.slice(0, -1).join(', ')} and ${authors.at(-1)}` : authors[0] ?? 'Someone'
    const summary = f.kind === 'branch'
        ? `${who} made ${f.commits.length} ${f.commits.length === 1 ? 'commit' : 'commits'} on ${f.title}, changing ${f.files.length} ${f.files.length === 1 ? 'file' : 'files'} (+${added} −${removed}) in ${areas.join(', ')}. Latest: "${f.commits[0]?.subject ?? f.title}".`
        : `${who} changed ${f.files.length} ${f.files.length === 1 ? 'file' : 'files'} (+${added} −${removed}) in ${areas.join(', ')}: "${f.title}".`
    const review: string[] = []
    for (const x of f.files.filter((x) => SENSITIVE.test(x.path)).slice(0, 2)) review.push(`Read ${x.path} closely: it touches payments, security or data.`)
    const code = f.files.filter((x) => /\.(t|j)sx?$|\.py$|\.go$|\.rb$|\.php$|\.cs$|\.java$|\.kt$|\.swift$/.test(x.path))
    if (code.length && !f.files.some((x) => TESTS.test(x.path))) review.push('No tests changed alongside the code. Ask how it was checked.')
    const big = [...f.files].sort((a, b) => (b.added ?? 0) + (b.removed ?? 0) - (a.added ?? 0) - (a.removed ?? 0))[0]
    if (big && (big.added ?? 0) + (big.removed ?? 0) > 80) review.push(`${big.path} changed the most (+${big.added} −${big.removed}). Start the review there.`)
    return { summary, review: review.slice(0, 3), model: null }
}

export async function explainChange(inference: Inference | null, f: ChangeFacts): Promise<Explanation>
{
    const plain = plainExplanation(f)
    if (!inference) return plain
    const commits = f.commits.slice(0, 30).map((c) => `- ${c.subject} (${c.author}, ${c.date.slice(0, 10)})`).join('\n')
    const files = f.files.slice(0, 60).map((x) => `- ${x.path} +${x.added ?? '?'} -${x.removed ?? '?'}`).join('\n')
    try {
        const reply = await inference.chat([
            {
                role: 'system',
                content: 'You explain code changes to a small software team and its manager, who may not read code. '
                    + 'Use plain words and name the real behaviour that changed for users or the business. Never invent anything the diff does not show. '
                    + 'Reply with JSON only: {"summary": "two or three short sentences", "review": ["up to three short, specific things a reviewer should check"]}',
            },
            {
                role: 'user',
                content: `Repository: ${f.repo}\nExplain this ${f.kind}: ${f.title}\n\nCommits:\n${commits}\n\nFiles:\n${files}\n\nDiff (may be cut):\n${f.patch.slice(0, 14_000)}`,
            },
        ], { maxTokens: 500, temperature: 0.2 })
        const json = extractJson(reply) as { summary?: unknown; review?: unknown } | null
        const summary = typeof json?.summary === 'string' ? json.summary.trim() : ''
        if (!summary) return plain
        const review = Array.isArray(json?.review) ? json.review.filter((r): r is string => typeof r === 'string' && !!r.trim()).slice(0, 3) : []
        return { summary: summary.slice(0, 800), review: review.map((r) => r.slice(0, 240)), model: inference.model }
    } catch (err) {
        console.error('explain: model failed, using the plain version', err)
        return plain
    }
}
