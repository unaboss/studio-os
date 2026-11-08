// A handful of line icons, drawn on a 24px grid with currentColor strokes.
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const make = (d: string | string[]) => () => (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
        {(Array.isArray(d) ? d : [d]).map((p) => <path key={p} d={p} />)}
    </svg>
)

export const Icon = {
    today: make(['M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0', 'M12 8v4l3 2']),
    projects: make(['M4 6h16v12H4z', 'M4 10h16', 'M9 10v8']),
    money: make(['M3 7h18v10H3z', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5', 'M6 12h.01M18 12h.01']),
    people: make(['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16 4.5a3.5 3.5 0 0 1 0 6.5', 'M18 14a6.5 6.5 0 0 1 3.5 6']),
    sales: make(['M4 19V9', 'M10 19V5', 'M16 19v-7', 'M22 19H2']),
    compliance: make(['M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z', 'M9 12l2 2 4-4']),
    automations: make(['M13 3L5 14h6l-1 7 8-11h-6z']),
    settings: make(['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 14.6H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9.4 4.6V4.5a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V10a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z']),
    activity: make(['M3 12h4l3-8 4 16 3-8h4']),
    tasks: make(['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4 6l1 1 2-2', 'M4 12l1 1 2-2', 'M4 18l1 1 2-2']),
    time: make(['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18', 'M12 7v5h4']),
    receipt: make(['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6', 'M9 12h6']),
    leave: make(['M3 20h18', 'M12 4a7 7 0 0 1 7 7H5a7 7 0 0 1 7-7', 'M12 11v9']),
    swap: make(['M7 7h13l-3-3', 'M17 17H4l3 3']),
    out: make(['M15 4h4v16h-4', 'M10 8l-4 4 4 4', 'M6 12h10']),
    plus: make(['M12 5v14', 'M5 12h14']),
    tree: make(['M6 3v12', 'M21 6a3 3 0 1 1-6 0a3 3 0 1 1 6 0', 'M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0', 'M18 9a9 9 0 0 1-9 9']),
    spark: make(['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M6 6l2.5 2.5', 'M15.5 15.5L18 18', 'M18 6l-2.5 2.5', 'M8.5 15.5L6 18']),
    check: make('M5 12.5l4.5 4.5L19 7'),
    x: make(['M6 6l12 12', 'M18 6L6 18']),
    menu: make(['M4 7h16', 'M4 12h16', 'M4 17h16']),
    github: make('M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21'),
    upload: make(['M12 16V4', 'M7 9l5-5 5 5', 'M4 20h16']),
    up: make('M6 15l6-6 6 6'),
    down: make('M6 9l6 6 6-6'),
}
