import { Capacitor, registerPlugin } from '@capacitor/core'
import { settings } from './settings'
import { plausibleWordTimes, type TimedWord } from '@reconnotes/core'

/**
 * On-device speech recognition with Apple's Speech framework
 * ==========================================================
 *
 * In the iOS/iPadOS app a small native plugin (SpeechRecognition, in
 * ios/App/App/SceneDelegate.swift) transcribes recordings and audio files on
 * the device: private, free and offline for most languages.
 */

interface SpeechRecognitionPlugin {
  /** `words`: each word and when it's said (seconds) – the transcript can then follow along as it plays */
  transcribe(options: { audio: string; ext: string; locale?: string }): Promise<{ text: string; words?: TimedWord[]; onDevice: boolean }>
}

const SpeechRecognition = registerPlugin<SpeechRecognitionPlugin>('SpeechRecognition')

/** Is Apple's speech recognizer available (running in the iOS app)? */
export function deviceSpeechAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('SpeechRecognition')
}

/** Available and switched on in Settings. */
export function useDeviceSpeech(): boolean {
  return deviceSpeechAvailable() && settings.get().deviceSpeech !== false
}

/** File extension Apple's decoder expects for this kind of audio. */
function extFor(mime: string): string {
  if (/mp4|m4a|aac/.test(mime)) return 'm4a'
  if (/mpeg|mp3/.test(mime)) return 'mp3'
  if (/wav/.test(mime)) return 'wav'
  if (/aiff/.test(mime)) return 'aiff'
  if (/caf/.test(mime)) return 'caf'
  return 'm4a'
}

/** Apple can't decode WebM/Ogg (recordings made in Chrome/Firefox): let the server do those. */
export function deviceCanDecode(mime: string): boolean {
  return !/webm|ogg|opus/.test(mime)
}

/** Apple's reading of a recording: its text, and each word's time where Apple gives real ones. */
export async function transcribeOnDevice(blob: Blob): Promise<{ text: string; words: TimedWord[] | null }> {
  const audio = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
  const { text, words } = await SpeechRecognition.transcribe({ audio, ext: extFor(blob.type) })
  return { text: text.trim(), words: plausibleWordTimes(words) }
}

/** Speech recognisers return one long block of text (split with speechToParagraphs from core). */
export { speechToParagraphs } from '@reconnotes/core'
