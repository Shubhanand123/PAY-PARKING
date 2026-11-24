import type { CapacitorConfig } from '@capacitor/cli'

// The app opens the live site, so screen and logic updates reach the POS without reinstalling.
// Only the native plate reader (ML Kit) ships inside the APK.
const config: CapacitorConfig = {
  appId: 'com.saiexpress.payparking',
  appName: 'Pay Parking',
  webDir: 'dist',
  server: {
    url: 'https://pay-parking-ekb.pages.dev',
    androidScheme: 'https',
  },
  android: { allowMixedContent: false },
}

export default config
