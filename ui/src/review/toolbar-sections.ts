/** Mirrors hidden state from a toolbar control group to its collapsible section. */
export function observeToolbarSectionVisibility(
  entries: readonly { target: HTMLElement; section: HTMLElement }[],
  Observer: typeof MutationObserver = MutationObserver,
): MutationObserver {
  const syncVisibility = (records?: MutationRecord[]) => {
    const changedTargets = records?.length ? new Set(records.map((record) => record.target)) : null;
    for (const { target, section } of entries) {
      if (changedTargets && !changedTargets.has(target)) continue;
      if (section.hidden !== target.hidden) section.hidden = target.hidden;
    }
  };
  const observer = new Observer((records) => syncVisibility(records));
  for (const { target } of entries) {
    observer.observe(target, { attributes: true, attributeFilter: ["hidden"] });
  }
  syncVisibility();
  return observer;
}
