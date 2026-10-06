import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.reconnotes.app',
  appName: 'ReconNotes',
  webDir: 'dist',
  ios: {
    contentInset: 'never',
    // Allow syncing with a server on your LAN over plain http (e.g. http://192.168.1.10:8787).
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    // a notification from the server shows even while the app is open
    PushNotifications: { presentationOptions: ['banner', 'sound', 'list'] },
  },
}

export default config
