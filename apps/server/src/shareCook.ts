import * as Y from 'yjs'
import { getContent } from '@reconnotes/core'
import { esc } from './shares'

/**
 * Cook mode on a shared recipe
 * ============================
 *
 * The same cook mode as in the app, for someone a recipe folder is shared with: all the steps as
 * numbered tiles with the ingredients down the side (ticked off as they go in), or one step at a
 * time – tap a tile to see it big, Next and Back (or swipe, or the arrow keys), and the screen kept
 * on where the browser allows it (over https).
 *
 * The page is built here from the note (every word escaped, as on any shared page); the one script
 * that runs is the fixed one below, fetched from the share address itself (script-src 'self') – so
 * nothing in a note can run. Without it, the page still shows everything, with ingredients to tick.
 */

const INGREDIENTS = /^ingredients\b/i
const STEPS = /^(steps|instructions|directions|method|preparation)\b/i

/** An element's words (links to notes by their words; nothing else that isn't text). */
function textOf(el: Y.XmlElement | Y.XmlText): string {
  if (el instanceof Y.XmlText) return (el.toDelta() as { insert: unknown }[]).map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('')
  if (el.nodeName === 'noteLink') return String(el.getAttribute('label') || el.getAttribute('title') || '')
  if (el.nodeName === 'hardBreak') return ' '
  return el
    .toArray()
    .map((c) => (c instanceof Y.XmlText || c instanceof Y.XmlElement ? textOf(c) : ''))
    .join('')
}

/** The items of the lists under a heading (up to the next heading of its level or above). */
function listUnder(doc: Y.Doc, re: RegExp): string[] {
  const out: string[] = []
  let inside = false
  const items = (list: Y.XmlElement) => {
    for (const item of list.toArray())
      if (item instanceof Y.XmlElement && /^(listItem|taskItem)$/.test(item.nodeName)) {
        const first = item.toArray()[0]
        const t = first instanceof Y.XmlElement ? textOf(first).replace(/\s+/g, ' ').trim() : ''
        if (t) out.push(t)
      }
  }
  for (const node of getContent(doc).toArray()) {
    if (!(node instanceof Y.XmlElement)) continue
    if (node.nodeName === 'heading') {
      inside = re.test(textOf(node).trim()) || (inside && Number(node.getAttribute('level') ?? 1) > 2)
      continue
    }
    if (inside && /^(bulletList|orderedList|taskList)$/.test(node.nodeName)) items(node)
  }
  return out
}

/** A recipe note's ingredients and steps – or null, when it isn't one (no ingredients, or no steps). */
export function recipeIn(doc: Y.Doc): { ingredients: string[]; steps: string[] } | null {
  const ingredients = listUnder(doc, INGREDIENTS)
  const steps = listUnder(doc, STEPS)
  return ingredients.length && steps.length ? { ingredients, steps } : null
}

/** The cook mode page. `back`: the recipe's own shared page. */
export function cookPage(title: string, recipe: { ingredients: string[]; steps: string[] }, back: string): string {
  const n = recipe.steps.length
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow"><title>Cook: ${esc(title)}</title>
<style>${CSS}</style></head>
<body><div class="cook" data-view="board">
<header class="cook-head">
  <a class="icon" href="${esc(back)}" aria-label="Back to the recipe">✕</a>
  <div class="cook-title">${esc(title)}</div>
  <div class="cook-views" role="radiogroup" aria-label="View">
    <button type="button" role="radio" aria-checked="false" data-view="step">› One step</button>
    <button type="button" role="radio" aria-checked="true" data-view="board" class="on">▦ All steps</button>
  </div>
  <button type="button" class="cook-ings-toggle" aria-pressed="false" aria-label="Ingredients">☑ <span class="label">Ingredients</span></button>
</header>
<div class="cook-body">
  <aside class="cook-side">
    <h2>Ingredients <span class="left">${recipe.ingredients.length} left</span></h2>
    <ul class="cook-check">${recipe.ingredients.map((t) => `<li><label><input type="checkbox"><span>${esc(t)}</span></label></li>`).join('')}</ul>
  </aside>
  <ol class="cook-tiles">${recipe.steps
    .map(
      (t, i) =>
        `<li class="tile" tabindex="0" data-i="${i}" aria-label="Step ${i + 1}"><div class="tile-head"><span class="num">${i + 1}</span><button type="button" class="tick" aria-pressed="false" aria-label="Mark step ${i + 1} done">✓</button></div><p>${esc(t)}</p></li>`,
    )
    .join('')}</ol>
  <section class="cook-one" aria-live="polite">
    <div class="count">Step <span class="at">1</span> of ${n}</div>
    <p class="one-text">${esc(recipe.steps[0] ?? '')}</p>
  </section>
</div>
<footer class="cook-nav">
  <button type="button" class="prev">‹ Back</button>
  <div class="dots" aria-hidden="true">${recipe.steps.map((_, i) => `<span${i ? '' : ' class="on"'}></span>`).join('')}</div>
  <button type="button" class="next primary">Next ›</button>
</footer>
<div class="zoom" hidden><div class="zoom-card" role="dialog" aria-modal="true">
  <div class="zoom-head"><span class="num big"></span><span class="count"></span><button type="button" class="icon close" aria-label="Close">✕</button></div>
  <p class="zoom-text"></p>
  <div class="zoom-nav"><button type="button" class="zprev">‹ Back</button><button type="button" class="zdone">✓ Mark done</button><button type="button" class="znext primary">Next ›</button></div>
</div></div>
</div>
<script src="/s/_/cook.js"></script>
</body></html>`
}

const CSS = `
:root { color-scheme: light dark; --bg: #faf8f3; --text: #1d1d1f; --muted: #777; --line: #ddd8cc; --accent: #e0a800; --accent-text: #8a6200; --card: #fff; --on: #fbe7a6; }
@media (prefers-color-scheme: dark) { :root { --bg: #161617; --text: #ececec; --muted: #9a9a9a; --line: #333; --card: #1f1f21; --accent-text: #ffd36b; --on: #4a3c12; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--text); font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
button { font: inherit; color: inherit; cursor: pointer; }
.cook { position: fixed; inset: 0; display: flex; flex-direction: column; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
.cook-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.icon { display: inline-grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; border: 0; background: none; color: var(--accent-text); text-decoration: none; font-size: 20px; flex-shrink: 0; }
.cook-title { flex: 1; min-width: 0; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cook-views { display: flex; gap: 3px; padding: 3px; border-radius: 10px; background: rgba(127,127,127,.14); flex-shrink: 0; }
.cook-views button { border: 0; border-radius: 8px; background: none; padding: 6px 10px; font-size: 14px; font-weight: 600; color: var(--muted); white-space: nowrap; }
.cook-views button.on { background: var(--card); color: var(--accent-text); box-shadow: 0 1px 3px rgba(0,0,0,.18); }
.cook-ings-toggle { display: none; border: 0; background: none; color: var(--accent-text); font-weight: 600; white-space: nowrap; }
.cook-ings-toggle[aria-pressed="true"] { text-decoration: underline; }
.cook-body { flex: 1; min-height: 0; display: flex; }
.cook-side { width: min(340px, 34%); border-right: 1px solid var(--line); overflow-y: auto; padding: 14px 16px; }
.cook-side h2 { font-size: 17px; margin: 0 0 8px; display: flex; justify-content: space-between; gap: 8px; }
.cook-side .left { font-size: 13px; font-weight: 500; color: var(--muted); }
.cook-check { list-style: none; margin: 0; padding: 0; }
.cook-check label { display: flex; gap: 10px; align-items: flex-start; padding: 8px 4px; border-bottom: 1px solid var(--line); cursor: pointer; }
.cook-check input { width: 20px; height: 20px; margin: 2px 0 0; accent-color: var(--accent); flex-shrink: 0; }
.cook-check input:checked + span { text-decoration: line-through; color: var(--muted); }
.cook-tiles { flex: 1; min-width: 0; overflow-y: auto; list-style: none; margin: 0; padding: 14px; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; align-content: start; }
.tile { border: 1px solid var(--line); border-radius: 14px; background: var(--card); padding: 12px 14px; cursor: pointer; display: flex; flex-direction: column; min-height: 140px; }
.tile:focus-visible { outline: 2px solid var(--accent); }
.tile p { margin: 8px 0 0; font-size: 16px; }
.tile.done { opacity: .5; }
.tile.done p { text-decoration: line-through; }
.tile-head { display: flex; justify-content: space-between; align-items: center; }
.num { display: inline-grid; place-items: center; min-width: 30px; height: 30px; border-radius: 50%; background: var(--accent); color: #1d1d1f; font-weight: 800; }
.num.big { min-width: 40px; height: 40px; font-size: 20px; }
.tick { width: 30px; height: 30px; border-radius: 50%; border: 1.5px solid var(--line); background: none; color: var(--muted); }
.tile.done .tick { background: var(--accent); border-color: var(--accent); color: #1d1d1f; }
.cook-one { display: none; flex: 1; overflow-y: auto; flex-direction: column; justify-content: center; max-width: 900px; margin: 0 auto; padding: 24px 28px; }
.cook-one .count { color: var(--accent-text); font-weight: 700; font-size: 15px; margin-bottom: 10px; }
.one-text { font-size: clamp(22px, 4.5vw, 34px); line-height: 1.4; margin: 0; }
.cook-nav { display: none; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--line); }
.cook-nav button, .zoom-nav button { border: 1px solid var(--line); background: var(--card); border-radius: 12px; padding: 12px 20px; font-weight: 700; font-size: 17px; }
.cook-nav button.primary, .zoom-nav .primary { background: var(--accent); border-color: var(--accent); color: #1d1d1f; }
.cook-nav button:disabled, .zoom-nav button:disabled { opacity: .4; }
.dots { display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; max-width: 50%; }
.dots span { width: 8px; height: 8px; border-radius: 50%; background: var(--line); }
.dots span.on { background: var(--accent); }
/* One step */
.cook[data-view="step"] .cook-side, .cook[data-view="step"] .cook-tiles { display: none; }
.cook[data-view="step"] .cook-one { display: flex; }
.cook[data-view="step"] .cook-nav { display: flex; }
.cook[data-view="step"] .cook-ings-toggle { display: inline-flex; }
.cook[data-view="step"].show-ings .cook-side { display: block; width: 100%; max-width: 640px; margin: 0 auto; border: 0; }
.cook[data-view="step"].show-ings .cook-one { display: none; }
/* a step shown big */
.zoom { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: grid; place-items: center; padding: 16px; }
.zoom[hidden] { display: none; }
.zoom-card { background: var(--bg); border-radius: 18px; width: min(720px, 100%); max-height: 90vh; overflow-y: auto; padding: 18px 20px; box-shadow: 0 12px 40px rgba(0,0,0,.3); }
.zoom-head { display: flex; align-items: center; gap: 10px; }
.zoom-head .count { flex: 1; color: var(--muted); font-weight: 600; }
.zoom-text { font-size: clamp(20px, 4vw, 28px); line-height: 1.45; margin: 16px 4px 22px; }
.zoom-nav { display: flex; gap: 8px; justify-content: space-between; flex-wrap: wrap; }
.zoom-nav .zdone[aria-pressed="true"] { border-color: var(--accent); color: var(--accent-text); }
/* a phone: the ingredients above the steps */
@media (max-width: 699px) {
  .cook-body { flex-direction: column; overflow-y: auto; }
  .cook-side { width: auto; border-right: 0; border-bottom: 1px solid var(--line); overflow: visible; }
  .cook-tiles { overflow: visible; grid-template-columns: 1fr; }
  .cook-views button { padding: 6px 8px; font-size: 13px; }
  .cook-ings-toggle .label { display: none; }
  .cook-head { gap: 6px; padding: 8px 10px; }
}
`

/** The cook mode page's script (the only one on any shared page): views, steps, ticks, the screen kept on. */
export const COOK_SCRIPT = `(() => {
  const root = document.querySelector('.cook')
  if (!root) return
  const $ = (s) => root.querySelector(s)
  const $$ = (s) => Array.from(root.querySelectorAll(s))
  const tiles = $$('.tile')
  const steps = tiles.map((t) => t.querySelector('p').textContent)
  const n = steps.length
  let at = 0
  let zoom = null
  const setView = (v) => {
    root.dataset.view = v
    $$('.cook-views button').forEach((b) => {
      const on = b.dataset.view === v
      b.classList.toggle('on', on)
      b.setAttribute('aria-checked', String(on))
    })
    root.classList.remove('show-ings')
    $('.cook-ings-toggle').setAttribute('aria-pressed', 'false')
  }
  const show = () => {
    $('.cook-one .at').textContent = String(at + 1)
    $('.one-text').textContent = steps[at]
    $$('.dots span').forEach((d, i) => d.classList.toggle('on', i === at))
    $('.prev').disabled = at === 0
    $('.next').textContent = at < n - 1 ? 'Next ›' : 'Done'
  }
  const go = (d) => {
    if (at === n - 1 && d > 0) return setView('board')
    at = Math.max(0, Math.min(n - 1, at + d))
    show()
  }
  const isDone = (i) => tiles[i].classList.contains('done')
  const toggleDone = (i) => {
    const on = !isDone(i)
    tiles[i].classList.toggle('done', on)
    tiles[i].querySelector('.tick').setAttribute('aria-pressed', String(on))
    if (zoom === i) $('.zdone').setAttribute('aria-pressed', String(on)), ($('.zdone').textContent = on ? '✓ Done' : '✓ Mark done')
  }
  const open = (i) => {
    zoom = Math.max(0, Math.min(n - 1, i))
    $('.zoom .num').textContent = String(zoom + 1)
    $('.zoom .count').textContent = 'Step ' + (zoom + 1) + ' of ' + n
    $('.zoom-text').textContent = steps[zoom]
    $('.zprev').disabled = zoom === 0
    $('.znext').textContent = zoom < n - 1 ? 'Next ›' : 'Close'
    $('.zdone').setAttribute('aria-pressed', String(isDone(zoom)))
    $('.zdone').textContent = isDone(zoom) ? '✓ Done' : '✓ Mark done'
    $('.zoom').hidden = false
  }
  const close = () => {
    zoom = null
    $('.zoom').hidden = true
  }
  $$('.cook-views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)))
  $('.cook-ings-toggle').addEventListener('click', (e) => {
    const on = root.classList.toggle('show-ings')
    e.currentTarget.setAttribute('aria-pressed', String(on))
  })
  $('.prev').addEventListener('click', () => go(-1))
  $('.next').addEventListener('click', () => go(1))
  tiles.forEach((t, i) => {
    t.addEventListener('click', (e) => (e.target.closest('.tick') ? toggleDone(i) : open(i)))
    t.addEventListener('keydown', (e) => e.key === 'Enter' && open(i))
  })
  $('.zoom').addEventListener('click', (e) => e.target === e.currentTarget && close())
  $('.zoom .close').addEventListener('click', close)
  $('.zprev').addEventListener('click', () => open(zoom - 1))
  $('.znext').addEventListener('click', () => (zoom < n - 1 ? open(zoom + 1) : close()))
  $('.zdone').addEventListener('click', () => toggleDone(zoom))
  // the ingredients still to go in
  const left = () => ($('.cook-side .left').textContent = $$('.cook-check input').filter((c) => !c.checked).length + ' left')
  $$('.cook-check input').forEach((c) => c.addEventListener('change', left))
  // keys and swipes: next and back
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return zoom !== null && close()
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!d) return
    if (zoom !== null) zoom + d >= 0 && zoom + d < n && open(zoom + d)
    else if (root.dataset.view === 'step') go(d)
  })
  let start = null
  root.addEventListener('touchstart', (e) => (start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null), { passive: true })
  root.addEventListener('touchend', (e) => {
    if (!start) return
    const dx = e.changedTouches[0].clientX - start.x
    const dy = e.changedTouches[0].clientY - start.y
    start = null
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return
    if (zoom !== null) open(zoom + (dx < 0 ? 1 : -1))
    else if (root.dataset.view === 'step') go(dx < 0 ? 1 : -1)
  })
  // the screen stays on while cooking (where the browser can: over https)
  let lock = null
  const keepOn = () => navigator.wakeLock && navigator.wakeLock.request('screen').then((l) => (lock = l)).catch(() => {})
  keepOn()
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepOn())
  show()
})()
`
