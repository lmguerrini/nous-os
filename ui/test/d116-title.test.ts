import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');
const letterMarkup = '<span class="brand-title-lead">N</span><span>O</span><span>U</span><span>S</span><span class="brand-title-lead">O</span><span class="brand-title-lead">S</span>';

test('toolbar title exposes NousOS once and draws the caps wordmark treatment', () => {
  assert.match(html, /<h1 class="nous-title"><span class="visually-hidden">NousOS<\/span><span class="brand-title" aria-hidden="true">/);
  assert.equal(html.split(letterMarkup).length - 1, 2);
  assert.equal((html.match(/<span class="visually-hidden">NousOS<\/span>/g) ?? []).length, 1);
  assert.equal((html.match(/<span class="brand-title" aria-hidden="true">/g) ?? []).length, 1);
  assert.match(html, /\.brand-title \{display:block;margin:0;color:var\(--text,#f0f0f0\);font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;font-size:var\(--brand-title-size,20px\);font-weight:600;letter-spacing:\.06em;line-height:1\.15;white-space:nowrap\}/);
  assert.doesNotMatch(html.match(/\.brand-title \{([^}]*)\}/)?.[1] ?? '', /text-shadow/);
  assert.match(html, /\.brand-title span \{display:inline;margin:0;color:inherit;font-size:\.78em;line-height:inherit;vertical-align:baseline\}/);
  assert.match(html, /\.brand-title \.brand-title-lead \{font-size:1em\}/);
  assert.match(html, /header\.toolbar-collapsed \{--brand-title-size:16px\}/);
  assert.match(html, /header\.toolbar-collapsed \.header-top > :not\(h1\):not\(#toolbar-toggle\):not\(#toolbar-summary\) \{display:none\}/);
});

test('fullscreen brand is decorative, pointer inert, and only displayed in fullscreen', () => {
  assert.match(html, /<div id="viewport" aria-label="Canvas del grafo di revisione"><div id="fullscreen-brand" aria-hidden="true"><span class="brand-title">[\s\S]*?<\/span><\/div><div id="render-root">/);
  assert.equal(html.split(letterMarkup).length - 1, 2);
  assert.match(html, /#fullscreen-brand \{display:none;position:absolute;z-index:20;top:12px;left:16px;pointer-events:none\}/);
  assert.match(html, /#fullscreen-brand \.brand-title \{text-shadow:0 0 2px rgba\(0,0,0,\.95\),0 0 6px rgba\(0,0,0,\.75\),0 0 12px rgba\(0,0,0,\.5\)\}/);
  assert.match(html, /#viewport:fullscreen #fullscreen-brand \{display:block\}/);
  assert.match(html, /#fullscreen-bar \{[^}]*z-index:26/);
});

test('title uses system fonts and references no downloadable font assets', () => {
  assert.doesNotMatch(html, /@font-face|(?:https?:)?\/\/[^\s"']*(?:fonts\.|font)/i);
  assert.doesNotMatch(html, /\.(?:woff2?|ttf|otf|eot)(?:[?#][^\s"']*)?/i);
  assert.doesNotMatch(html, /<link\b[^>]*rel=["']stylesheet["'][^>]*>/i);
});
