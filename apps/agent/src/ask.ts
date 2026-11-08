// Ask the agent anything about the code at one commit. The server hands it
// the facts (the commit, what it changed, the trimmed diff, every file in the
// repo at that point, and any file the question names) and the agent answers
// from those alone. With no model it still answers from the same facts.
import type { ChatMessage, Inference } from './inference.ts'

export interface CodeFacts
{
    readonly repo: string
    readonly sha: string
    readonly commit: { subject: string; body?: string; author: string; date: string }
    readonly changed: readonly { path: string; added: number | null; removed: number | null }[]
    readonly patch: string
    /** Every file in the repo at this commit. */
    readonly files: readonly string[]
    /** Files the question names, read at this commit (already trimmed). */
    readonly opened: readonly { path: string; content: string }[]
}

export interface Answer
{
    readonly answer: string
    /** The model that wrote it, or null for the plain version. */
    readonly model: string | null
}

export type Turn = Pick<ChatMessage, 'role' | 'content'> & { role: 'user' | 'assistant' }

/** The files a question names, by full path or by file name, best first. */
export function filesNamed(question: string, files: readonly string[], max = 2): string[]
{
    const q = question.toLowerCase()
    const hits = files.filter((f) => q.includes(f.toLowerCase()))
    for (const f of files) {
        const name = f.split('/').at(-1)!.toLowerCase()
        if (name.length >= 4 && !hits.includes(f) && new RegExp(`(^|[^\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(q)) hits.push(f)
    }
    return hits.slice(0, max)
}

export function plainAnswer(f: CodeFacts): string
{
    const c = f.commit
    const lines: string[] = []
    const named = f.opened.map((o) => o.path)
    if (named.length) {
        for (const path of named) {
            const ch = f.changed.find((x) => x.path === path)
            const size = f.opened.find((o) => o.path === path)!.content.split('\n').length
            lines.push(ch
                ? `${path} was changed in this commit (+${ch.added ?? '?'} −${ch.removed ?? '?'}). At this point it has about ${size} lines.`
                : `${path} was not touched by this commit. At this point it has about ${size} lines.`)
        }
    } else {
        lines.push(`At ${f.sha.slice(0, 7)}, ${c.author.split(' ')[0]} committed "${c.subject}", changing ${f.changed.length} ${f.changed.length === 1 ? 'file' : 'files'}: ${f.changed.slice(0, 4).map((x) => x.path).join(', ') || 'none'}.`)
        const top = [...new Set(f.files.map((p) => (p.includes('/') ? p.split('/')[0] + '/' : p)))].slice(0, 8)
        lines.push(`The repo has ${f.files.length} files at this point, including ${top.join(', ')}.`)
    }
    lines.push('No model is connected on this server, so this is only what the commit itself shows. Add an inference key to get full answers.')
    return lines.join(' ')
}

const SYSTEM = 'You are the code agent inside Studio OS, a code CRM for software teams. '
    + 'You answer questions about one repository at one commit, for developers and for managers who may not read code. '
    + 'Use only the facts given: the commit, its diff, the file list and any files shown. If they do not answer the question, say what you would need to look at. '
    + 'Be short and concrete: name files, functions and behaviour. Plain text, no Markdown headings, at most about 150 words unless asked for more.'

export function factsMessage(f: CodeFacts): string
{
    const changed = f.changed.slice(0, 60).map((x) => `- ${x.path} +${x.added ?? '?'} -${x.removed ?? '?'}`).join('\n')
    const files = f.files.slice(0, 400).join('\n') + (f.files.length > 400 ? `\n… and ${f.files.length - 400} more` : '')
    const opened = f.opened.map((o) => `--- ${o.path} ---\n${o.content}`).join('\n\n')
    return `Repository: ${f.repo}\nCommit: ${f.sha.slice(0, 10)} "${f.commit.subject}" by ${f.commit.author} on ${f.commit.date.slice(0, 10)}`
        + (f.commit.body ? `\n${f.commit.body.slice(0, 1000)}` : '')
        + `\n\nFiles this commit changed:\n${changed || '(none)'}\n\nDiff (may be cut):\n${f.patch.slice(0, 10_000)}`
        + `\n\nEvery file in the repo at this commit:\n${files}`
        + (opened ? `\n\nFiles the question names, at this commit:\n${opened}` : '')
}

export async function askAboutCode(inference: Inference | null, f: CodeFacts, question: string, history: readonly Turn[] = []): Promise<Answer>
{
    if (!inference) return { answer: plainAnswer(f), model: null }
    try {
        const reply = await inference.chat([
            { role: 'system', content: SYSTEM },
            { role: 'user', content: factsMessage(f) },
            { role: 'assistant', content: 'I have the commit, its diff and the files. What would you like to know?' },
            ...history.slice(-8).map((t) => ({ role: t.role, content: t.content.slice(0, 4000) })),
            { role: 'user', content: question },
        ], { maxTokens: 600, temperature: 0.2 })
        const answer = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        if (!answer) return { answer: plainAnswer(f), model: null }
        return { answer: answer.slice(0, 4000), model: inference.model }
    } catch (err) {
        console.error('ask: model failed, using the plain answer', err)
        return { answer: plainAnswer(f), model: null }
    }
}
