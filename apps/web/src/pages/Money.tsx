import { useRef, useState } from 'react'
import { announceChange, api, date, money } from '../api.ts'
import { Icon } from '../icons.tsx'
import { Dialog, PageHead, Pill, RecordList, useRunAction, useStudio } from '../ui.tsx'

type Tab = 'invoices' | 'bank' | 'claims' | 'quotes'

export function Money()
{
    const [tab, setTab] = useState<Tab>('invoices')
    const [importing, setImporting] = useState(false)
    const run = useRunAction()
    return (
        <>
            <PageHead title="Money" sub="Invoices, the bank feed and expense claims. Sending anything to a client needs your approval.">
                <button className="btn" onClick={() => run('bank.auto_match', {})}>Match payments</button>
                <button className="btn primary" onClick={() => setImporting(true)}><Icon.upload /> Import statement</button>
            </PageHead>
            <div className="tabs">
                {(['invoices', 'bank', 'claims', 'quotes'] as Tab[]).map((t) => (
                    <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'bank' ? 'Bank lines' : t === 'claims' ? 'Expense claims' : t[0]!.toUpperCase() + t.slice(1)}</button>
                ))}
            </div>
            {tab === 'invoices' ? <RecordList type="invoice" columns={['number', 'client', 'amount', 'paid', 'due']} /> : null}
            {tab === 'bank' ? <RecordList type="bank_line" columns={['date', 'amount', 'account', 'matchedTo']} title="Add a line" /> : null}
            {tab === 'claims' ? <RecordList type="expense" columns={['claimant', 'amount', 'date', 'category']} /> : null}
            {tab === 'quotes' ? <RecordList type="quote" columns={['client', 'amount', 'validUntil']} /> : null}
            {importing ? <ImportStatement onClose={() => setImporting(false)} /> : null}
        </>
    )
}

interface ReadResult
{
    known: boolean
    learnt?: boolean
    parserId?: string
    notes?: string
    code?: string
    count: number
    preview: { date: string; amount: number; description: string; balance: number | null }[]
}

/**
 * Known bank formats import straight away. An unknown one is handed to the
 * agent, which writes a parser that runs in the sandbox; you see what it
 * read before anything is saved.
 */
function ImportStatement({ onClose }: { onClose: () => void })
{
    const { me, toast } = useStudio()
    const file = useRef<HTMLInputElement>(null)
    const [csv, setCsv] = useState('')
    const [account, setAccount] = useState('Business cheque')
    const [read, setRead] = useState<ReadResult | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [showCode, setShowCode] = useState(false)

    const load = async (f: File) => {
        const text = await f.text()
        setCsv(text)
        setRead(null)
        setError(null)
        setBusy(text.length > 0 ? 'Reading the statement…' : null)
        try {
            setRead(await api<ReadResult>('/api/bank/read', { body: { csv: text } }))
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(null)
        }
    }

    const doImport = async () => {
        setBusy('Importing…')
        try {
            const res = await api<{ added: number; skipped: number }>('/api/bank/import', { body: { csv, account, ...(read?.parserId ? { parserId: read.parserId } : {}) } })
            toast(`${res.added} lines added${res.skipped ? `, ${res.skipped} were already there` : ''}`)
            announceChange()
            onClose()
        } catch (e) {
            setError((e as Error).message)
            setBusy(null)
        }
    }

    return (
        <Dialog
            wide
            title="Import a bank statement"
            onClose={onClose}
            foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!read || !!busy} onClick={doImport}>{read ? `Import ${read.count} lines` : 'Import'}</button></>}
        >
            <p className="muted">Download a CSV from your bank's online banking (FNB, Absa, Nedbank, Capitec and Standard Bank work out of the box) and choose it here. Lines already imported are skipped.</p>
            <div className="form-grid">
                <label className="field"><span>Statement file</span><input ref={file} className="input" type="file" accept=".csv,.txt,text/csv" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} /></label>
                <label className="field"><span>Account name</span><input className="input" value={account} onChange={(e) => setAccount(e.target.value)} /></label>
            </div>
            {busy ? <div className="note-box">{busy}{busy.startsWith('Reading') ? ' If the format is new, the agent is writing a reader for it; that can take half a minute.' : ''}</div> : null}
            {error ? <div className="error-box">{error}</div> : null}
            {read && !read.known ? (
                <div className="note-box">
                    <strong>{read.learnt ? 'New format learnt.' : 'Format recognised from before.'}</strong> The agent wrote a reader for this statement{read.notes ? ` (${read.notes})` : ''}. It ran in the sandbox, with no network and no access to anything else, and read {read.count} lines. Check them below before importing.{' '}
                    <button className="btn ghost sm" onClick={() => setShowCode(!showCode)}>{showCode ? 'Hide' : 'Show'} its code</button>
                    {showCode ? <pre className="mono" style={{ whiteSpace: 'pre-wrap', marginTop: 8, maxHeight: 220, overflow: 'auto' }}>{read.code}</pre> : null}
                </div>
            ) : null}
            {read ? (
                <div className="card table-wrap">
                    <table className="table">
                        <thead><tr><th>Date</th><th>Description</th><th className="right">Amount</th><th className="right">Balance</th></tr></thead>
                        <tbody>
                            {read.preview.map((l, i) => (
                                <tr key={i} style={{ cursor: 'default' }}>
                                    <td>{date(l.date)}</td>
                                    <td>{l.description}</td>
                                    <td className="right num" style={{ color: l.amount < 0 ? 'var(--ink)' : 'var(--good)' }}>{money(l.amount, me.currency)}</td>
                                    <td className="right num faint">{l.balance === null ? '—' : money(l.balance, me.currency)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {read.count > read.preview.length ? <div className="empty small">and {read.count - read.preview.length} more <Pill>{read.count} in total</Pill></div> : null}
                </div>
            ) : null}
        </Dialog>
    )
}
