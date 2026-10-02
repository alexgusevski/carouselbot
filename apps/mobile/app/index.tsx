import React, { useState } from 'react';
import { View, Text, Modal, StyleSheet, Platform, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@clerk/expo';
import { AuthView } from '../src/NativeAuth';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors as c } from '../src/theme';
import { Button, Loading, IconButton } from '../src/ui';
import { Library } from '../src/Library';
function Welcome({ onSignIn }: { onSignIn?: () => void }) {
  return (
    <SafeAreaView style={s.screen}>
      <View style={s.brand}>
        <Ionicons name="albums" size={25} color={c.ink} />
        <Text style={s.brandText}>carouselbot</Text>
      </View>
      <View style={s.art}>
        <View
          style={[
            s.card,
            { transform: [{ rotate: '-12deg' }], left: '10%', backgroundColor: '#DCEABF' },
          ]}
        >
          <Text style={s.cardSmall}>ONE IDEA.</Text>
          <Text style={s.cardTitle}>Make it{'\n'}a carousel.</Text>
          <View style={s.cardRule} />
        </View>
        <View
          style={[
            s.card,
            { transform: [{ rotate: '9deg' }], right: '8%', top: 34, backgroundColor: '#E5DFC9' },
          ]}
        >
          <Text style={s.cardSmall}>YOUR PHOTOS.{'\n'}YOUR WORDS.</Text>
          <Text style={s.cardTitle}>
            A little{'\n'}help with{'\n'}the rest.
          </Text>
        </View>
      </View>
      <View style={s.copy}>
        <Text style={s.title}>Your ideas.{'\n'}Ready to swipe.</Text>
        <Text style={s.subtitle}>
          Turn your photos and words into carousels. Tell the agent what to change, or make it yours
          by hand.
        </Text>
      </View>
      <View style={{ padding: 24, gap: 12 }}>
        {onSignIn ? (
          <Button label="Get started" icon="arrow-forward" onPress={onSignIn} />
        ) : (
          <Text style={{ color: c.muted, fontSize: 14, textAlign: 'center' }}>
            This build needs its CarouselBot account configuration.
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try the editor"
          onPress={() => router.push('/demo')}
          style={{ minHeight: 44, justifyContent: 'center', alignItems: 'center' }}
        >
          <Text style={{ color: c.ink, fontSize: 15 }}>Try the editor</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
function AuthenticatedHome() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const [open, setOpen] = useState(false);
  if (!isLoaded) return <Loading />;
  return (
    <View style={{ flex: 1 }}>
      {isSignedIn ? <Library /> : <Welcome onSignIn={() => setOpen(true)} />}
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: c.paper }}>
          <View style={{ alignItems: 'flex-end', paddingHorizontal: 10 }}>
            <IconButton name="close" label="Close sign in" onPress={() => setOpen(false)} />
          </View>
          <AuthView onDismiss={() => setOpen(false)} />
        </SafeAreaView>
      </Modal>
    </View>
  );
}
export default function Home() {
  return process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ? <AuthenticatedHome /> : <Welcome />;
}
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.paper },
  brand: { flexDirection: 'row', gap: 9, alignItems: 'center', padding: 24 },
  brandText: { fontSize: 22, letterSpacing: -0.8, fontWeight: '700', color: c.ink },
  art: { flex: 1, minHeight: 210, maxHeight: 380, marginVertical: 10, justifyContent: 'center' },
  card: {
    position: 'absolute',
    width: '49%',
    aspectRatio: 0.68,
    borderRadius: 20,
    padding: 23,
    justifyContent: 'space-between',
    shadowColor: '#26351A',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 12 },
    elevation: 4,
  },
  cardTitle: { color: c.ink, fontWeight: '700', fontSize: 28, lineHeight: 31, letterSpacing: -1 },
  cardSmall: {
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 1.5,
    color: c.accentInk,
    fontWeight: '600',
  },
  cardRule: { height: 2, width: 45, backgroundColor: c.ink },
  copy: { paddingHorizontal: 27, gap: 13 },
  title: { fontSize: 40, fontWeight: '700', letterSpacing: -1.7, lineHeight: 44, color: c.ink },
  subtitle: { fontSize: 16, lineHeight: 24, color: c.muted },
});
