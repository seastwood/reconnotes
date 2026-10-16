import { Archive, Bell, Bot, PenTool, RefreshCw, ScanText, ScrollText, SlidersHorizontal, type LucideIcon } from 'lucide-react'

/** The pages of Settings (kept apart, so the app can name them without loading Settings itself). */
export type SettingsTab = 'general' | 'sync' | 'ai' | 'prompts' | 'recognition' | 'pencil' | 'notifications' | 'data'

export const SETTINGS_TABS: {
  id: SettingsTab
  label: string
  icon: LucideIcon
  blurb: string
}[] = [
  {
    id: 'general',
    label: 'General',
    icon: SlidersHorizontal,
    blurb: 'How ReconNotes looks and behaves on this device.',
  },
  {
    id: 'sync',
    label: 'Sync & devices',
    icon: RefreshCw,
    blurb: 'Your ReconNotes server, and the devices that use it.',
  },
  {
    id: 'ai',
    label: 'AI agents',
    icon: Bot,
    blurb: 'The models your server uses, and which one does what.',
  },
  {
    id: 'prompts',
    label: 'Prompts',
    icon: ScrollText,
    blurb: 'What the AI is told for each kind of job – change it, or put it back to the default.',
  },
  {
    id: 'recognition',
    label: 'Handwriting & speech',
    icon: ScanText,
    blurb: 'Reading handwriting, pictures and recordings – on your server and on this device.',
  },
  {
    id: 'pencil',
    label: 'Pencil & drawing',
    icon: PenTool,
    blurb: 'Apple Pencil, finger drawing and shapes.',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: Bell,
    blurb: 'Reminders, notifications, your calendar feed and the weekly digest.',
  },
  {
    id: 'data',
    label: 'Sharing & backups',
    icon: Archive,
    blurb: 'What’s shared with others, backups of your library, offsite copies, and moving notes in and out.',
  },
]
