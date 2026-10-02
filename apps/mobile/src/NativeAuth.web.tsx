import React from 'react';
import { Text, View } from 'react-native';
export function AuthView({ onDismiss }: { onDismiss: () => void }) {
  return (
    <View style={{ padding: 25 }}>
      <Text>Open a native build to sign in. The web product is available at carousel.bot.</Text>
    </View>
  );
}
