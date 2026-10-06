/** Visible, dismissible notices for the Geometry Lab migration and refusal paths. */
const NOTICE_DURATION_MS = 8_000;
let dismissalTimer: number | null = null;
/** The overlays a visible notice must never cover, in either layout. A control that reads as a
 * zero rect (display:none toolbar in fullscreen, a closed panel) is invisible and ignored. */
const NOTICE_CONTROL_IDS = ['selection-focus-controls', 'fullscreen-bar', 'appearance-panel'] as const;
const NOTICE_CLEARANCE_PX = 12;

function positionLabNotice(): void {
  if (typeof document === 'undefined') return;
  const viewport = document.getElementById('viewport');
  const header = document.getElementById('review-toolbar');
  const panel = document.getElementById('details');
  const { host } = noticeElements() ?? {};
  if (!viewport || !header || !panel || !host) return;

  const viewportRect = viewport.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  // The free region keeps excluding the open details column: the notice stays centred in what
  // remains, exactly as before, and the column never counts as a control to dodge below.
  const panelRect = panel.getBoundingClientRect();
  const panelOpen = panelRect.width > 0 && panelRect.height > 0;
  let regionLeft = viewportRect.left;
  let regionRight = panelOpen ? Math.max(regionLeft, panelRect.left - NOTICE_CLEARANCE_PX) : viewportRect.right;
  // Below the wrapping toolbar; in fullscreen its rect is zero and this stays the 8 px top.
  let top = headerRect.bottom - viewportRect.top + 8;
  // The horizontal band the notice occupies at its widest: centred in the region, maxWidth wide.
  let halfWidth = Math.max(0, regionRight - regionLeft - 24) / 2;
  let centre = (regionLeft + regionRight) / 2;

  for (const id of NOTICE_CONTROL_IDS) {
    const control = document.getElementById(id);
    if (!control) continue;
    const rect = control.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.right <= centre - halfWidth || rect.left >= centre + halfWidth) continue;
    if (rect.bottom - viewportRect.top <= top) continue;
    if (rect.left >= centre) {
      // A side control the band reaches is dodged by narrowing, keeping the notice high.
      regionRight = Math.min(regionRight, rect.left - NOTICE_CLEARANCE_PX);
    } else if (rect.right <= centre) {
      regionLeft = Math.max(regionLeft, rect.right + NOTICE_CLEARANCE_PX);
    } else {
      // A control straddling the centre cannot be narrowed away: the notice goes below it.
      top = Math.max(top, rect.bottom - viewportRect.top + 8);
    }
    halfWidth = Math.max(0, regionRight - regionLeft - 24) / 2;
    centre = (regionLeft + regionRight) / 2;
  }
  if (regionRight < regionLeft) regionRight = regionLeft;

  host.style.top = `${top}px`;
  host.style.left = `${centre - viewportRect.left}px`;
  host.style.maxWidth = `${Math.max(0, regionRight - regionLeft - 24)}px`;
}

function observeLabNoticeGeometry(): void {
  if (typeof document === 'undefined') return;
  const viewport = document.getElementById('viewport');
  const header = document.getElementById('review-toolbar');
  const panel = document.getElementById('details');
  const controls = NOTICE_CONTROL_IDS.map(id => document.getElementById(id));
  const ResizeObserverCtor = globalThis.ResizeObserver;
  if (typeof ResizeObserverCtor === 'function') {
    const observer = new ResizeObserverCtor(positionLabNotice);
    for (const element of [viewport, header, panel, ...controls]) if (element) observer.observe(element);
  }
  if (typeof window !== 'undefined') window.addEventListener('resize', positionLabNotice);
}

function noticeElements(): { host: HTMLElement; message: HTMLElement; close: HTMLButtonElement } | null {
  if (typeof document === 'undefined') return null;
  const host = document.getElementById('lab-notice');
  const message = document.getElementById('lab-notice-message');
  const close = document.getElementById('lab-notice-close');
  return host && message && close
    ? { host: host as HTMLElement, message: message as HTMLElement, close: close as HTMLButtonElement } : null;
}

export function dismissLabNotice(): void {
  const elements = noticeElements();
  if (elements) {
    elements.host.hidden = true;
    elements.message.textContent = '';
  }
  if (dismissalTimer !== null && typeof window !== 'undefined') window.clearTimeout(dismissalTimer);
  dismissalTimer = null;
}

export function showLabNotice(message: string): void {
  if (!message || message === 'Grafo pronto') return;
  const elements = noticeElements();
  if (!elements) return;
  if (dismissalTimer !== null) window.clearTimeout(dismissalTimer);
  elements.message.textContent = message;
  elements.host.hidden = false;
  positionLabNotice();
  dismissalTimer = window.setTimeout(() => {
    if (elements.message.textContent === message) dismissLabNotice();
  }, NOTICE_DURATION_MS);
}

if (typeof document !== 'undefined') {
  observeLabNoticeGeometry();
  const close = document.getElementById('lab-notice-close');
  if (close && typeof close.addEventListener === 'function') close.addEventListener('click', dismissLabNotice);
  if (typeof document.addEventListener === 'function') document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && noticeElements()?.host.hidden === false) dismissLabNotice();
  });
}
