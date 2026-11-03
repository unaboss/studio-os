import { PageHead, RecordList, Tile } from '../ui.tsx'
import { useApi, type TileData } from '../api.ts'

export function Sales()
{
    const { data } = useApi<{ tiles: { id: string; title: string; size: 'md'; data?: TileData }[] }>('/api/today?side=manage')
    const pipeline = data?.tiles.find((t) => t.id === 'sales.pipeline')
    return (
        <>
            <PageHead title="Sales" sub="Leads and follow-ups. Winning a lead creates the client and the project, phases and all." />
            {pipeline?.data ? <div className="tiles" style={{ marginBottom: 18 }}><Tile info={{ ...pipeline, size: 'lg' }} data={pipeline.data} /></div> : null}
            <RecordList type="lead" columns={['company', 'value', 'followUp', 'nextStep']} />
        </>
    )
}
