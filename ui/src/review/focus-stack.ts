import type { ReviewExport } from "./model.ts";
import type { ProductView } from "./view-contract.ts";

export type FocusFrame = { readonly id: string; readonly ids: readonly string[]; readonly capped: boolean };
export class FocusStack {
  private frames: FocusFrame[] = [];
  private readonly data: Pick<ReviewExport, "edges">;
  private readonly visible: () => ReadonlySet<string>;
  private readonly view: () => ProductView | null;
  private readonly cap: number;
  constructor(data: Pick<ReviewExport, "edges">, visible: () => ReadonlySet<string>, view: () => ProductView | null, cap = 60) {
    this.data = data; this.visible = visible; this.view = view; this.cap = cap;
  }
  get depth() { return this.frames.length; }
  get current(): FocusFrame | null { return this.frames.at(-1) ?? null; }
  get ids(): readonly string[] { return this.frames.map((frame) => frame.id); }
  private neighbours(seeds: ReadonlySet<string>): { ids: string[]; capped: boolean } {
    const visible = this.visible(); const found = new Set([...seeds].filter((id) => visible.has(id)));
    let capped = false;
    for (const edge of this.data.edges) {
      if (!visible.has(edge.source) || !visible.has(edge.target)) continue;
      if (!seeds.has(edge.source) && !seeds.has(edge.target)) continue;
      for (const id of [edge.source, edge.target]) if (!found.has(id)) {
        if (found.size >= this.cap) capped = true; else found.add(id);
      }
    }
    return { ids: [...found], capped };
  }
  private async apply(frame: FocusFrame | null): Promise<void> {
    const view = this.view(); if (!view) return;
    const ids = frame?.ids.filter((id) => this.visible().has(id)) ?? [];
    view.select(frame?.id ?? null); view.setEmphasis(frame ? new Set(ids) : null);
    if (ids.length) await view.frame(ids); else await view.fit();
  }
  async select(id: string): Promise<void> {
    const edge = this.data.edges.find((item) => item.id === id);
    const seeds = edge ? new Set([edge.source, edge.target]) : new Set([id]);
    const { ids, capped } = edge ? { ids: [...seeds].filter((node) => this.visible().has(node)), capped: false } : this.neighbours(seeds);
    if (!ids.length) return;
    this.frames.push({ id, ids, capped }); await this.apply(this.current);
  }
  async expand(): Promise<void> {
    const current = this.current; if (!current) return;
    const { ids, capped } = this.neighbours(new Set(current.ids));
    this.frames.push({ id: current.id, ids, capped }); await this.apply(this.current);
  }
  async back(): Promise<void> { if (this.frames.length) this.frames.pop(); await this.apply(this.current); }
  async reset(): Promise<void> { this.frames = []; await this.apply(null); }
  async restore(): Promise<void> { await this.apply(this.current); }
}
