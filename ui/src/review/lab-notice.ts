/** Visible, dismissible notices for the Geometry Lab migration and refusal paths. */
const NOTICE_DURATION_MS = 8_000;
let dismissalTimer: number | null = null;

function positionLabNotice(): void {
  if (typeof document === 'undefined') return;
  const viewport = document.getElementById('viewport');
  const header = document.getElementById('review-toolbar');
  const panel = document.getElementById('details');
  const { host } = noticeElements() ?? {};
  if (!viewport || !header || !panel || !host) return;

  const viewportRect = viewport.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const panelOpen = panelRect.width > 0 && panelRect.height > 0;
  const regionLeft = viewportRect.left;
  const regionRight = panelOpen ? Math.max(regionLeft, panelRect.left - 12) : viewportRect.right;
  const regionWidth = Math.max(0, regionRight - regionLeft);

  host.style.top = `${headerRect.bottom - viewportRect.top + 8}px`;
  host.style.left = `${(regionLeft + regionRight) / 2 - viewportRect.left}px`;
  host.style.maxWidth = `${Math.max(0, regionWidth - 24)}px`;
}

function observeLabNoticeGeometry(): void {
  if (typeof document === 'undefined') return;
  const viewport = document.getElementById('viewport');
  const header = document.getElementById('review-toolbar');
  const panel = document.getElementById('details');
  const ResizeObserverCtor = globalThis.ResizeObserver;
  if (typeof ResizeObserverCtor === 'function') {
    const observer = new ResizeObserverCtor(positionLabNotice);
    for (const element of [viewport, header, panel]) if (element) observer.observe(element);
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
