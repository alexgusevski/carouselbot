import React from 'react';
import { Stack } from 'expo-router';
import { ClerkProvider, useAuth } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ApiProvider } from '../src/context';
import { colors } from '../src/theme';

function Routes() {
  const { isSignedIn } = useAuth();
  return (
    <ApiProvider>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.paper } }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="demo" />
        <Stack.Protected guard={Boolean(isSignedIn)}>
          <Stack.Screen name="editor/[id]" />
          <Stack.Screen name="account" options={{ presentation: 'modal' }} />
        </Stack.Protected>
      </Stack>
    </ApiProvider>
  );
}
export default function RootLayout() {
  const key = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {key ? (
        <ClerkProvider publishableKey={key} tokenCache={tokenCache}>
          <Routes />
        </ClerkProvider>
      ) : (
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="demo" />
        </Stack>
      )}
    </SafeAreaProvider>
  );
}
