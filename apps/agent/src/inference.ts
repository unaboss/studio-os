/** One chat turn. Vultr Serverless Inference speaks the OpenAI chat format. */
export interface ChatMessage
{
    readonly role: 'system' | 'user' | 'assistant'
    readonly content: string
}

export interface Inference
{
    readonly model: string
    chat(messages: readonly ChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<string>
}

export interface VultrOptions
{
    readonly apiKey: string
    readonly model: string
    readonly baseUrl?: string
    readonly fetchImpl?: typeof fetch
    readonly timeoutMs?: number
}

export const VULTR_BASE_URL = 'https://api.vultrinference.com/v1'

export function vultrInference(opts: VultrOptions): Inference
{
    const base = (opts.baseUrl ?? VULTR_BASE_URL).replace(/\/$/, '')
    const f = opts.fetchImpl ?? fetch
    return {
        model: opts.model,
        async chat(messages, o = {}) {
            const res = await f(`${base}/chat/completions`, {
                method: 'POST',
                headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
                body: JSON.stringify({
                    model: opts.model,
                    messages,
                    max_tokens: o.maxTokens ?? 1200,
                    temperature: o.temperature ?? 0.2,
                }),
                signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
            })
            if (!res.ok) throw new Error(`Vultr inference failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
            const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
            const text = body.choices?.[0]?.message?.content
            if (typeof text !== 'string') throw new Error('Vultr inference returned no message')
            return text
        },
    }
}

/** The model ids this key can use, from GET /models. */
export async function listModels(apiKey: string, baseUrl = VULTR_BASE_URL, f: typeof fetch = fetch): Promise<string[]>
{
    const res = await f(`${baseUrl.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${apiKey}` } })
    if (!res.ok) throw new Error(`Listing models failed: ${res.status}`)
    const body = (await res.json()) as { data?: { id: string }[] }
    return (body.data ?? []).map((m) => m.id)
}

/**
 * Pulls the first JSON object out of a model reply, which may wrap it in
 * a code fence or add a sentence before it. Reasoning models may also emit
 * a <think> block first; that is skipped.
 */
export function extractJson(text: string): unknown
{
    const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '')
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned)
    const candidate = fenced ? fenced[1]! : cleaned
    const start = candidate.indexOf('{')
    if (start < 0) throw new Error('No JSON object in the reply')
    let depth = 0
    let inString = false
    for (let i = start; i < candidate.length; i++) {
        const ch = candidate[i]
        if (inString) {
            if (ch === '\\') i++
            else if (ch === '"') inString = false
        } else if (ch === '"') inString = true
        else if (ch === '{') depth++
        else if (ch === '}') {
            depth--
            if (depth === 0) return JSON.parse(candidate.slice(start, i + 1))
        }
    }
    throw new Error('Unfinished JSON object in the reply')
}
