// Stat tile: label, value, optional hint. Proportional figures on the value (not tabular).

export default function StatTile({ label, value, unit, hint }: { label: string; value: string; unit?: string; hint?: string }) {
  return (
    <div className="summary-stat-tile">
      <div className="text-xs text-[var(--viz-ink-2)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-[var(--viz-ink)]">
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-[var(--viz-ink-2)]">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-[var(--viz-muted)]">{hint}</div>}
    </div>
  );
}
