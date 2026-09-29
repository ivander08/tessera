/**
 * The number this whole project exists to move.
 *
 * A hit rate below ~80% after twenty turns means the prefix is being mutated
 * somewhere upstream, and the M3.3 prefix-guard warning names the segment.
 */
export function CacheMeter({ hitRate }: { hitRate: number | null }) {
  if (hitRate === null) {
    return <span className="text-xs text-ink-dim">cache —</span>;
  }

  const percent = hitRate * 100;
  const tone = percent >= 80 ? 'text-emerald-400' : percent >= 40 ? 'text-amber-400' : 'text-red-400';

  return (
    <span className="flex items-center gap-2 text-xs">
      <span className="text-ink-dim">cache</span>
      <span className={`font-mono font-semibold ${tone}`}>{percent.toFixed(1)}%</span>
    </span>
  );
}
