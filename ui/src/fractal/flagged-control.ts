/** The experimental choice is absent from the live document without opt-in. */
export function removeUnflaggedFractalControls(doc: Pick<Document, 'querySelectorAll'>,
  enabled: boolean): void {
  if (enabled) return;
  doc.querySelectorAll('[data-axis="organization"] button[data-value="fractal"]')
    .forEach(button => button.remove());
}
