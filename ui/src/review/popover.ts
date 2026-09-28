/** A single stack for Escape, button toggles and pressed state across review surfaces. */
export class PopoverStack {
  private readonly opened: string[] = [];
  private readonly listeners = new Set<() => void>();
  isOpen(id: string): boolean { return this.opened.includes(id); }
  order(): readonly string[] { return [...this.opened]; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  set(id: string, open: boolean): void {
    const index = this.opened.indexOf(id);
    if (index >= 0) this.opened.splice(index, 1);
    if (open) this.opened.push(id);
    for (const listener of this.listeners) listener();
  }
  toggle(id: string): void { this.set(id, !this.isOpen(id)); }
  closeTop(canClose: (id: string) => boolean = () => true): string | null {
    const id = this.opened.at(-1);
    if (!id || !canClose(id)) return null;
    this.set(id, false);
    return id;
  }
}

export type SurfaceBinding = {
  id: string; surface: HTMLElement; openers: HTMLElement[];
  readOpen: () => boolean; writeOpen: (open: boolean) => void;
  canClose?: () => boolean;
};

export function bindSurfaces(bindings: SurfaceBinding[]): PopoverStack {
  const stack = new PopoverStack();
  const byId = new Map(bindings.map(binding => [binding.id, binding]));
  const sync = (binding: SurfaceBinding) => {
    const open = stack.isOpen(binding.id);
    if (binding.readOpen() !== open) binding.writeOpen(open);
    for (const opener of binding.openers) {
      opener.setAttribute('aria-pressed', String(open));
      opener.classList.toggle('surface-active', open);
      if (opener.tagName === 'SUMMARY') opener.setAttribute('aria-expanded', String(open));
    }
  };
  stack.subscribe(() => bindings.forEach(sync));
  for (const binding of bindings) {
    if (binding.readOpen()) stack.set(binding.id, true);
    for (const opener of binding.openers) opener.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (stack.isOpen(binding.id) && binding.canClose && !binding.canClose()) return;
      stack.toggle(binding.id);
    });
    const close = document.createElement('button'); close.type = 'button'; close.className = 'surface-close';
    close.textContent = '×'; close.setAttribute('aria-label', `Chiudi ${binding.id}`);
    close.addEventListener('click', event => {
      event.stopPropagation();
      if (binding.canClose && !binding.canClose()) return;
      stack.set(binding.id, false);
    });
    const install = () => { if (!binding.surface.contains(close)) binding.surface.prepend(close); };
    install();
    new MutationObserver(install).observe(binding.surface, { childList: true });
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const closed = stack.closeTop(id => byId.get(id)?.canClose?.() ?? true);
    if (closed) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  return stack;
}
