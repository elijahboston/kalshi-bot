/** Category display helpers for the UI */

const CATEGORY_LABELS: Record<string, string> = {
  high_temp: "HIGH",
  low_temp: "LOW",
  precip: "RAIN",
  snowfall: "SNOW",
};

const CATEGORY_CSS: Record<string, string> = {
  high_temp: "cat-high-temp",
  low_temp: "cat-low-temp",
  precip: "cat-precip",
  snowfall: "cat-snowfall",
};

/** Render an HTML badge for a market category */
export function categoryBadge(category: string): string {
  const label = CATEGORY_LABELS[category] ?? category.toUpperCase();
  const css = CATEGORY_CSS[category] ?? "";
  return `<span class="cat-badge ${css}">${label}</span>`;
}

/** Infer category from a ticker string (e.g. KXRAINNY-26MAR23-T0.1 → precip) */
export function categoryFromTicker(ticker: string): string {
  if (ticker.startsWith("KXHIGH")) return "high_temp";
  if (ticker.startsWith("KXLOW")) return "low_temp";
  if (ticker.startsWith("KXRAIN")) return "precip";
  if (ticker.startsWith("KXSNOW")) return "snowfall";
  return "unknown";
}

/** Short label for CLI display (no HTML) */
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}
