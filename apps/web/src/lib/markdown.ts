import { marked } from 'marked'

/**
 * Strikethrough only between double tildes (~~gone~~): a single one is "about"
 * – "(~58 mm) and height 4½ in (~114 mm)" isn't crossed out.
 */
marked.use({
  tokenizer: {
    del(src: string) {
      const m = /^~~(?=[^\s~])([\s\S]*?[^\s~])~~(?!~)/.exec(src)
      if (!m) return undefined
      return { type: 'del', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) }
    },
  },
})

export { marked }
