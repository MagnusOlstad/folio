type Props = {
  label: string;
  value: number;
  max: number;
  /** Shimmer instead of a fill while nothing measurable has happened yet. */
  indeterminate?: boolean;
  compact?: boolean;
};

/** Determinate or indeterminate progress bar with a polite live status line. */
export function TranslationProgress({ label, value, max, indeterminate = false, compact = false }: Props) {
  const unknown = indeterminate || max <= 0;
  const percent = unknown ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div className={`translation-progress${compact ? " is-compact" : ""}`}>
      <div
        className={`translation-progress-bar${unknown ? " is-indeterminate" : ""}`}
        role="progressbar"
        aria-label="Translation progress"
        aria-valuemin={0}
        aria-valuemax={unknown ? undefined : max}
        aria-valuenow={unknown ? undefined : value}
      >
        <span style={unknown ? undefined : { width: `${percent}%` }} />
      </div>
      <p className="translation-status" role="status" aria-live="polite">{label}</p>
    </div>
  );
}
