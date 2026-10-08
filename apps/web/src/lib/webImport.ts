import { runJob } from './jobs'
import { showToast } from './toast'

/**
 * Check imported web pages for updates (one note, or a folder of them): the
 * server fetches them again and brings the changed ones up to date. It runs
 * as a job; the result is shown when it's done (and stays in Jobs).
 */
export async function checkForUpdates(where: { noteId?: string; folderId?: string }) {
  showToast('Checking for updates… (see Jobs)')
  try {
    const job = await runJob({ kind: 'web-refresh', noteId: where.noteId ?? null, input: where })
    if (job.status === 'failed') return showToast(`Couldn’t check for updates: ${job.error ?? 'unknown error'}`, undefined, 9000)
    const notes = (job.result?.notes as string[] | undefined) ?? []
    showToast(notes.slice(0, 3).join(' ') || 'Checked.', undefined, 9000)
  } catch (e) {
    showToast(`Couldn’t check for updates: ${(e as Error).message}`, undefined, 9000)
  }
}
