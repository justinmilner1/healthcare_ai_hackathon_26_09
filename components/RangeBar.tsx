// Time below / in / above range as one meter. Status colors carry meaning, so each segment is also labeled.

export default function RangeBar({ tbr, tir, tar }: { tbr: number; tir: number; tar: number }) {
  const segs = [
    { key: "below", label: "Below 70", pct: tbr, color: "var(--viz-critical)" },
    { key: "in", label: "In range 70–180", pct: tir, color: "var(--viz-good)" },
    { key: "above", label: "Above 180", pct: tar, color: "var(--viz-serious)" },
  ];
  return (
    <div>
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded">
        {segs.map((s) => (
          <div key={s.key} style={{ width: `${Math.max(s.pct * 100, s.pct > 0 ? 1 : 0)}%`, background: s.color }} title={`${s.label}: ${pct(s.pct)}`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--viz-ink-2)]">
        {segs.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label} <span className="font-medium text-[var(--viz-ink)]">{pct(s.pct)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
