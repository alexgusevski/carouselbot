import type { ExpoConfig } from 'expo/config';

if (process.env.EAS_BUILD_PROFILE === 'production') {
  for (const name of [
    'EXPO_PUBLIC_API_URL',
    'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY',
    'EXPO_PUBLIC_REVENUECAT_IOS_KEY',
    'EXPO_PUBLIC_REVENUECAT_ANDROID_KEY',
    'EXPO_PUBLIC_PRIVACY_URL',
    'EXPO_PUBLIC_TERMS_URL',
  ]) {
    if (!process.env[name])
      throw new Error(
        `Production build requires ${name}. Configure the CarouselBot EAS production environment first.`,
      );
  }
  if (!process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!.startsWith('pk_live_'))
    throw new Error('Production builds require the live CarouselBot Clerk instance.');
  for (const name of ['EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_PRIVACY_URL', 'EXPO_PUBLIC_TERMS_URL'])
    if (!process.env[name]!.startsWith('https://'))
      throw new Error(`${name} must be an HTTPS URL.`);
}

const config: ExpoConfig = {
  name: 'CarouselBot',
  slug: 'carouselbot',
  owner: 'alexgusevski',
  version: '1.0.0',
  scheme: 'carouselbot',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  icon: './assets/icon.png',
  backgroundColor: '#F7F7F2',
  ios: {
    bundleIdentifier: 'com.beundra.carouselbot',
    supportsTablet: true,
    usesAppleSignIn: true,
    config: { usesNonExemptEncryption: false },
  },
  android: {
    package: 'com.beundra.carouselbot',
    predictiveBackGestureEnabled: true,
    softwareKeyboardLayoutMode: 'resize',
    adaptiveIcon: { foregroundImage: './assets/icon.png', backgroundColor: '#E6EFCF' },
    blockedPermissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_AUDIO',
      'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
      'com.google.android.gms.permission.AD_ID',
    ],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    '@clerk/expo',
    [
      'expo-image-picker',
      {
        photosPermission: 'Choose photos and videos for your carousels.',
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
    [
      'expo-media-library',
      {
        photosPermission: 'Access exported slides.',
        savePhotosPermission: 'Save your finished slides to Photos.',
        granularPermissions: ['photo', 'video'],
      },
    ],
    [
      'expo-splash-screen',
      { backgroundColor: '#F7F7F2', image: './assets/icon.png', imageWidth: 92 },
    ],
  ],
  web: { bundler: 'metro', output: 'single' },
  extra: {
    eas: {
      projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID || '7b7652ae-4c24-47fd-9cb9-6f1dac8c243c',
    },
  },
};
export default config;
