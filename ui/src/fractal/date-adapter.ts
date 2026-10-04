/** C0's read-only date rule table, scoped to the experimental canopy. */
import patch from './date-patch.json' with { type: 'json' };

export type FractalDateRule = Readonly<{
  id: string; date: string | null; date_unknown: boolean;
  rule: 'owner_conversation_date_proxy' | 'unknown_no_unique_dated_provenance';
  evidence: string | null;
}>;

const rules = new Map<string, FractalDateRule>((patch as FractalDateRule[]).map(row => [row.id, row]));

/** A proxy is attachment context, never the source record's creation date. */
export function adaptFractalDates<T extends { id: string; date?: string | null }>(nodes: readonly T[]): (T & {
  date_unknown?: boolean; fractal_date_rule?: string; fractal_date_evidence?: string;
})[] {
  return nodes.map(node => {
    if (node.date !== null && node.date !== undefined) return node;
    // A new dataset can contain undated records absent from the verified D-080
    // table. Unknown is the only honest default; never manufacture a proxy.
    const rule = rules.get(node.id) ?? { id: node.id, date: null, date_unknown: true,
      rule: 'unknown_no_unique_dated_provenance' as const, evidence: null };
    const { date: _old, ...rest } = node;
    if (rule.date !== null && !rule.evidence) throw new Error(`Fractal proxy has no evidence: ${node.id}`);
    return rule.date === null
      ? { ...rest, date_unknown: true, fractal_date_rule: rule.rule } as T & { date_unknown: boolean; fractal_date_rule: string }
      : { ...rest, date: rule.date, fractal_date_rule: rule.rule,
          fractal_date_evidence: rule.evidence! } as T & { fractal_date_rule: string; fractal_date_evidence: string };
  });
}

export function fractalDateRule(id: string): FractalDateRule | undefined { return rules.get(id); }
/** A proxy is visibly distinguished from a source date wherever a Fractal date is printed. */
export function fractalDateCaption(node: { date?: string | null; fractal_date_rule?: string }): string | null {
  if (!node.date) return null;
  return node.fractal_date_rule === 'owner_conversation_date_proxy'
    ? `${node.date} · data proxy della conversazione` : node.date;
}
export function fractalDateRuleCounts(): { proxies: number; unknown: number } {
  let proxies = 0, unknown = 0;
  for (const rule of rules.values()) if (rule.date_unknown) unknown++; else proxies++;
  return { proxies, unknown };
}
