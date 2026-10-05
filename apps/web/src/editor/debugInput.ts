import { useEffect } from 'react'
import type { Editor } from '@tiptap/react'
import { useSettings } from '../lib/settings'

/**
 * Troubleshooting aid (Settings › Log typing events): logs what the browser
 * and the editor do while typing or writing with Scribble, one line per
 * event, prefixed "[input]". In the iOS app these appear in Xcode's console.
 */
export function useInputDebugLog(editor: Editor | null) {
  const on = useSettings((s) => Boolean(s.debugInput))
  useEffect(() => {
    if (!on || !editor) return
    const dom = editor.view.dom
    const t0 = performance.now()
    const log = (...a: unknown[]) => console.log(`[input] ${Math.round(performance.now() - t0)}ms`, ...a)
    const sel = () => {
      const s = editor.state.selection
      return `sel ${s.from}-${s.to}`
    }
    const onEvent = (e: Event) => {
      const ie = e as InputEvent
      const pe = e as PointerEvent
      if (e.type.startsWith('pointer')) log(e.type, pe.pointerType, Math.round(pe.clientX), Math.round(pe.clientY))
      else if (e.type === 'beforeinput' || e.type === 'input') log(e.type, ie.inputType, JSON.stringify(ie.data), sel())
      else if (e.type.startsWith('composition')) log(e.type, JSON.stringify((e as CompositionEvent).data))
      else log(e.type, sel())
    }
    const types = ['focus', 'blur', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend', 'pointerdown', 'pointerup', 'pointercancel']
    for (const t of types) dom.addEventListener(t, onEvent, true)
    const onSel = () => {
      const s = getSelection()
      log('selectionchange', s?.anchorNode?.nodeName, s?.anchorOffset, sel())
    }
    document.addEventListener('selectionchange', onSel)
    const onTr = ({ transaction: tr }: { transaction: import('@tiptap/pm/state').Transaction }) => {
      const steps = tr.steps.map((st) => (st.toJSON() as { stepType?: string }).stepType ?? '?').join(',')
      const meta = ['y-sync$', 'focus', 'blur', 'pointer', 'uiEvent', 'addToHistory', 'composition']
        .filter((k) => tr.getMeta(k) !== undefined)
        .join(',')
      log('transaction', tr.docChanged ? `changed [${steps}]` : 'no change', tr.selectionSet ? sel() : '', meta && `meta: ${meta}`)
    }
    editor.on('transaction', onTr)
    log('logging on')
    return () => {
      for (const t of types) dom.removeEventListener(t, onEvent, true)
      document.removeEventListener('selectionchange', onSel)
      editor.off('transaction', onTr)
    }
  }, [on, editor])
}
