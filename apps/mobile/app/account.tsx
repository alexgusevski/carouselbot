import React, { useCallback, useState } from 'react';
import { Text, View, ScrollView, Alert, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useUser, useClerk } from '@clerk/expo';
import { useFocusEffect, router } from 'expo-router';
import { useApi } from '../src/context';
import { Button, IconButton, Loading, styles as s } from '../src/ui';
import { colors as c } from '../src/theme';
import { presentPaywall, restorePurchases, clearPurchasesIdentity } from '../src/billing';
import { clearAccountDrafts } from '../src/drafts';
import type { Account } from '../src/types';
export default function AccountScreen() {
  const api = useApi(),
    { user } = useUser(),
    { signOut } = useClerk();
  const [account, setAccount] = useState<Account | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setAccount(await api.account());
      setError('');
    } catch (error: any) {
      setError(error.message);
    }
  }, [api]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (error: any) {
      Alert.alert('Please try again', error.message);
    } finally {
      setBusy(false);
    }
  };
  const manage = () =>
    void run(async () => {
      const result = await api.request('/api/billing/portal', 'POST', {});
      await Linking.openURL(result.url);
    });
  const deleteAccount = () =>
    Alert.alert(
      'Delete your account?',
      'This permanently removes your carousels and uploaded media. Your store subscription must be canceled separately in the store where you purchased it.',
      [
        { text: 'Keep account', style: 'cancel' },
        {
          text: 'Delete account',
          style: 'destructive',
          onPress: () =>
            void run(async () => {
              try {
                await api.request('/api/account', 'DELETE');
              } catch (error: any) {
                if (error.code !== 'ACCOUNT_DELETED') throw error;
              }
              if (user) clearAccountDrafts(user.id);
              api.clearMedia();
              try {
                await user?.delete();
              } catch {
                throw new Error(
                  'Your CarouselBot data has been deleted. Sign in again if prompted, then retry Delete account to finish removing your sign-in profile.',
                );
              }
              await clearPurchasesIdentity();
              await signOut();
              router.replace('/');
            }),
        },
      ],
    );
  return (
    <SafeAreaView style={s.screen}>
      <View style={s.header}>
        <IconButton name="close" label="Close account" onPress={() => router.back()} />
        <Text style={{ fontSize: 19, fontWeight: '600', color: c.ink }}>Your account</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 24, gap: 25 }}>
        <View style={{ gap: 8 }}>
          <Text style={s.title}>{user?.firstName || 'Your workspace'}</Text>
          <Text style={s.muted}>{user?.primaryEmailAddress?.emailAddress}</Text>
        </View>
        {error ? (
          <Text style={{ color: c.danger }}>{error}</Text>
        ) : !account ? (
          <Loading text="Checking your subscription…" />
        ) : (
          <View style={{ padding: 22, borderRadius: 22, backgroundColor: c.accent, gap: 14 }}>
            <Text style={{ fontSize: 23, fontWeight: '600', color: c.ink }}>
              {account.billing.active ? 'CarouselBot Pro' : 'Make room for your next idea.'}
            </Text>
            <Text style={{ color: c.accentInk, fontSize: 15, lineHeight: 22 }}>
              {account.billing.active
                ? `${account.credits} agent credits available. Your subscription works on the app and web.`
                : 'Subscribe to create and edit with the agent. Manual editing is available with your account.'}
            </Text>
            {account.billing.active ? (
              <>
                <Text style={{ color: c.accentInk, fontSize: 13 }}>
                  {account.billing.provider === 'polar'
                    ? 'Purchased on the web'
                    : account.billing.store === 'app_store'
                      ? 'Purchased on the App Store'
                      : 'Purchased on Google Play'}
                  {account.billing.periodEnd
                    ? ` · current period ends ${new Date(account.billing.periodEnd).toLocaleDateString()}`
                    : ''}
                </Text>
                <Button label="Manage subscription" secondary disabled={busy} onPress={manage} />
              </>
            ) : (
              <Button
                label="Get CarouselBot Pro"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    setAccount(await presentPaywall(api, user!.id));
                  })
                }
              />
            )}
          </View>
        )}
        <Button
          label="Restore app purchases"
          secondary
          disabled={busy}
          onPress={() =>
            void run(async () => {
              const result = await restorePurchases(api, user!.id);
              setAccount(result);
              Alert.alert(
                result.billing.active
                  ? 'Subscription restored'
                  : 'No active app subscription found',
                result.billing.active
                  ? 'Your subscription is available on all your devices.'
                  : 'Check that you’re using the store account that made the purchase.',
              );
            })
          }
        />
        <View style={{ gap: 12 }}>
          <Button
            label="Privacy policy"
            secondary
            disabled={!process.env.EXPO_PUBLIC_PRIVACY_URL}
            onPress={() => void Linking.openURL(process.env.EXPO_PUBLIC_PRIVACY_URL!)}
          />
          <Button
            label="Terms of use"
            secondary
            disabled={!process.env.EXPO_PUBLIC_TERMS_URL}
            onPress={() => void Linking.openURL(process.env.EXPO_PUBLIC_TERMS_URL!)}
          />
          <Button
            label="Get help"
            secondary
            onPress={() =>
              void Linking.openURL('mailto:kontakt@beundraab.se?subject=CarouselBot%20support')
            }
          />
        </View>
        <Button
          label="Sign out"
          secondary
          disabled={busy}
          onPress={() =>
            void run(async () => {
              api.clearMedia();
              await clearPurchasesIdentity();
              await signOut();
              router.replace('/');
            })
          }
        />
        <Button label="Delete account" secondary disabled={busy} onPress={deleteAccount} />
      </ScrollView>
    </SafeAreaView>
  );
}
