/** A single stack for Escape, button toggles and pressed state across review surfaces. */
// D087-TOOLBAR BEGIN
export function customDensityLabel(amount: number | undefined): string {
  return amount === undefined ? 'Custom' : `Custom · ${new Intl.NumberFormat('it-IT', { useGrouping: true }).format(amount)}`;
}
// D087-TOOLBAR END
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

export type EscapeAction = { type: 'close'; id: string } | { type: 'exit-focus' } | { type: 'default' };

/** Resolve Escape once: topmost transient surface, then focus/neighbourhood, then page defaults. */
export function escapeAction(
  opened: readonly string[], transientIds: ReadonlySet<string>, focusActive: boolean,
): EscapeAction {
  for (let index = opened.length - 1; index >= 0; index -= 1) {
    const id = opened[index];
    if (id === undefined) continue;
    if (transientIds.has(id)) return { type: 'close', id };
  }
  return focusActive ? { type: 'exit-focus' } : { type: 'default' };
}

export type SurfaceBinding = {
  id: string; surface: HTMLElement; openers: HTMLElement[];
  readOpen: () => boolean; writeOpen: (open: boolean) => void;
  canClose?: () => boolean;
  // D087-TOOLBAR BEGIN: opt-in outside dismissal for a transient anchored editor.
  closeOnOutside?: boolean;
  syncPressed?: boolean;
  // D087-TOOLBAR END
};

// D087-TOOLBAR BEGIN
export function isOutsideSurface(binding: Pick<SurfaceBinding, 'surface' | 'openers'>, target: Node): boolean {
  return !binding.surface.contains(target) && !binding.openers.some(opener => opener.contains(target));
}
// D087-TOOLBAR END

export function bindSurfaces(
  bindings: SurfaceBinding[],
  focusActive: () => boolean = () => false,
  exitFocus: () => void = () => undefined,
): PopoverStack {
  const stack = new PopoverStack();
  const byId = new Map(bindings.map(binding => [binding.id, binding]));
  const transientIds = new Set(bindings.map(binding => binding.id).filter(id => id !== 'panel'));
  const sync = (binding: SurfaceBinding) => {
    const open = stack.isOpen(binding.id);
    if (binding.readOpen() !== open) binding.writeOpen(open);
    for (const opener of binding.openers) {
      if (binding.syncPressed !== false) opener.setAttribute('aria-pressed', String(open));
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
  // D087-TOOLBAR BEGIN: a press inside the editor or its opener stays inside the surface.
  document.addEventListener('pointerdown', event => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    for (const binding of bindings) {
      if (!binding.closeOnOutside || !stack.isOpen(binding.id)) continue;
      if (!isOutsideSurface(binding, target)) continue;
      stack.set(binding.id, false);
    }
  }, true);
  // D087-TOOLBAR END
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    // Escape precedence is transient surface, focus/neighbourhood, then today's page behaviour.
    const action = escapeAction(stack.order(), transientIds, focusActive());
    if (action.type === 'close') {
      // The transient may sit below the side panel in the stack: close it by id, not by position.
      if (byId.get(action.id)?.canClose?.() ?? true) stack.set(action.id, false);
      event.preventDefault(); event.stopImmediatePropagation();
    } else if (action.type === 'exit-focus') {
      event.preventDefault(); event.stopImmediatePropagation(); exitFocus();
    } else {
      // Nothing transient and no focus: the topmost remaining surface (the side panel) closes.
      const closed = stack.closeTop(id => byId.get(id)?.canClose?.() ?? true);
      if (closed) { event.preventDefault(); event.stopImmediatePropagation(); }
    }
  }, true);
  return stack;
}
