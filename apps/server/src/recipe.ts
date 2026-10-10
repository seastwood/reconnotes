/**
 * Recipes on web pages
 * ====================
 *
 * Nearly every recipe site puts the recipe in the page a second time, for
 * search engines: schema.org "Recipe" data (JSON-LD) with its name, photo,
 * servings, times, every ingredient, the steps in order and the nutrition.
 * Read from there it's exact – nothing guessed, nothing left out – and it
 * becomes a recipe card at the top of the note: ingredients as a checklist
 * (a shopping list too), steps numbered.
 */

export interface Recipe {
  name: string
  description?: string
  image?: string
  servings?: string
  prep?: string
  cook?: string
  total?: string
  ingredients: string[]
  /** the steps, in sections when the recipe has them ("For the sauce") */
  steps: { section?: string; steps: string[] }[]
  nutrition: [string, string][]
  cuisine?: string
  category?: string
}

type Json = Record<string, unknown>
const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v])
const text = (v: unknown): string =>
  typeof v === 'string'
    ? v
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
        .replace(/\s+/g, ' ')
        .trim()
    : typeof v === 'number'
      ? String(v)
      : ''
const isRecipe = (o: Json) => asArray(o['@type'] as string | string[]).some((t) => String(t).toLowerCase() === 'recipe')

/** Every object in the page's JSON-LD (inside @graph and arrays too). */
function objects(v: unknown, out: Json[] = []): Json[] {
  if (Array.isArray(v)) v.forEach((x) => objects(x, out))
  else if (v && typeof v === 'object') {
    out.push(v as Json)
    const g = (v as Json)['@graph']
    if (g) objects(g, out)
  }
  return out
}

/** "PT1H5M" → "1 hr 5 min" */
export function duration(iso: unknown): string | undefined {
  const m = typeof iso === 'string' ? /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(iso.trim()) : null
  if (!m) return undefined
  const mins = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  if (!mins) return undefined
  const h = Math.floor(mins / 60)
  const r = mins % 60
  return [h && `${h} hr`, r && `${r} min`].filter(Boolean).join(' ')
}

function imageOf(v: unknown): string | undefined {
  for (const x of asArray(v as unknown[])) {
    if (typeof x === 'string' && x) return x
    if (x && typeof x === 'object') {
      const u = (x as Json).url ?? (x as Json).contentUrl
      if (typeof u === 'string' && u) return u
    }
  }
  return undefined
}

function stepsOf(v: unknown): Recipe['steps'] {
  const out: Recipe['steps'] = []
  const plain: string[] = []
  for (const x of asArray(v as unknown[])) {
    if (typeof x === 'string') {
      // one string with every step: split on its lines
      plain.push(...x.split(/\n+|(?<=\.)\s+(?=\d+\.\s)/).map(text).filter(Boolean))
    } else if (x && typeof x === 'object') {
      const o = x as Json
      const types = asArray(o['@type'] as string | string[]).map(String)
      if (types.includes('HowToSection')) {
        if (plain.length) out.push({ steps: plain.splice(0) })
        out.push({ section: text(o.name), steps: stepsOf(o.itemListElement).flatMap((s) => s.steps) })
      } else {
        const t = text(o.text ?? o.name)
        if (t) plain.push(t)
      }
    }
  }
  if (plain.length) out.push({ steps: plain })
  return out.filter((s) => s.steps.length)
}

const NUTRIENTS: [string, string][] = [
  ['calories', 'Calories'],
  ['carbohydrateContent', 'Carbohydrates'],
  ['proteinContent', 'Protein'],
  ['fatContent', 'Fat'],
  ['saturatedFatContent', 'Saturated fat'],
  ['cholesterolContent', 'Cholesterol'],
  ['sodiumContent', 'Sodium'],
  ['fiberContent', 'Fiber'],
  ['sugarContent', 'Sugar'],
]

/** The recipe in a page's JSON-LD, if it has one (with ingredients and steps). */
export function recipeIn(scripts: string[]): Recipe | null {
  for (const raw of scripts) {
    let data: unknown
    try {
      data = JSON.parse(raw.trim())
    } catch {
      continue
    }
    const r = objects(data).find(isRecipe)
    if (!r) continue
    const ingredients = asArray(r.recipeIngredient as string[]).map(text).filter(Boolean)
    const steps = stepsOf(r.recipeInstructions)
    if (!ingredients.length || !steps.length) continue
    const yields = asArray(r.recipeYield as string[]).map(text).filter(Boolean)
    const n = (r.nutrition ?? {}) as Json
    return {
      name: text(r.name) || 'Recipe',
      description: text(r.description) || undefined,
      image: imageOf(r.image),
      // "8" and "8 servings": the fuller one
      servings: yields.sort((a, b) => b.length - a.length)[0],
      prep: duration(r.prepTime),
      cook: duration(r.cookTime),
      total: duration(r.totalTime),
      ingredients,
      steps,
      nutrition: NUTRIENTS.map(([k, label]) => [label, text(n[k])] as [string, string]).filter(([, v]) => v),
      cuisine: asArray(r.recipeCuisine as string[]).map(text).filter(Boolean).join(', ') || undefined,
      category: asArray(r.recipeCategory as string[]).map(text).filter(Boolean).join(', ') || undefined,
    }
  }
  return null
}

/**
 * The recipe card, as Markdown: `picture` gives the photo's place in the note (or null), `esc`
 * escapes text for Markdown.
 */
export function recipeCard(r: Recipe, picture: string | null, esc: (s: string) => string): string {
  const facts = [
    r.servings && `**Servings:** ${esc(r.servings)}`,
    r.prep && `**Prep:** ${r.prep}`,
    r.cook && `**Cook:** ${r.cook}`,
    r.total && `**Total:** ${r.total}`,
  ].filter(Boolean)
  const multi = r.steps.length > 1
  const lines = [
    ...(picture ? [`![${esc(r.name)}](${picture})`, ''] : []),
    ...(r.description ? [`*${esc(r.description)}*`, ''] : []),
    // tagged: every recipe found together (and the recipe tools know it)
    `${facts.join(' · ')}${facts.length ? ' · ' : ''}#recipe`,
    '',
    '## Ingredients',
    '',
    ...r.ingredients.map((i) => `- [ ] ${esc(i)}`),
    '',
    '## Steps',
    '',
    ...r.steps.flatMap((s) => [...(multi && s.section ? [`### ${esc(s.section)}`, ''] : []), ...s.steps.map((t, k) => `${k + 1}. ${esc(t)}`), '']),
    ...(r.nutrition.length ? ['## Nutrition', '', `${r.nutrition.map(([k, v]) => `${k}: ${esc(v)}`).join(' · ')}`, ''] : []),
    ...(r.cuisine || r.category ? [`*${[r.category, r.cuisine].filter(Boolean).map((x) => esc(x!)).join(' · ')}*`, ''] : []),
  ]
  return lines.join('\n').trim()
}

/** The site's own recipe card in the article (WP Recipe Maker, Tasty, Mediavine…): left out when the card is made. */
export const SITE_RECIPE_CARDS =
  '.wprm-recipe-container, .wprm-recipe, .tasty-recipes, .mv-create-card, .mv-recipe-card, .recipe-card, .easyrecipe, .zlrecipe-container, [itemtype*="schema.org/Recipe"], .wprm-recipe-snippet, .wprm-jump-to-recipe-shortcode, .tasty-recipes-jump-link'
