import { PageHead, RecordList, useRunAction } from '../ui.tsx'

export function Compliance()
{
    const run = useRunAction()
    return (
        <>
            <PageHead title="Compliance" sub="SARS and CIPC deadlines. The agent checks them every morning and warns you a week ahead.">
                <button className="btn" onClick={() => run('compliance.check', {})}>Check now</button>
                <button className="btn primary" onClick={() => run('compliance.seed', {})}>Add the standard deadlines</button>
            </PageHead>
            <RecordList type="obligation" columns={['kind', 'period', 'due', 'amount']} title="Add a deadline" />
            <p className="small faint" style={{ marginTop: 12 }}>Standard deadlines come from your year end, VAT and incorporation date in Settings. Public holidays are not counted, so check SARS's calendar around them.</p>
        </>
    )
}
