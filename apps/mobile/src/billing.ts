import { Platform } from 'react-native';
import Purchases, { LOG_LEVEL } from 'react-native-purchases';
import RevenueCatUI from 'react-native-purchases-ui';
import type { MobileApi } from './api';
import type { Account } from './types';

let configured = false;
let currentUser: string | null = null;
let identityQueue = Promise.resolve();
export function identifyPurchases(userId: string) {
  identityQueue = identityQueue
    .catch(() => {})
    .then(async () => {
      const key =
        Platform.OS === 'ios'
          ? process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY
          : process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY;
      if (!key || Platform.OS === 'web')
        throw new Error('App subscriptions are not configured in this build.');
      if (!configured) {
        Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.DEBUG : LOG_LEVEL.ERROR);
        Purchases.configure({ apiKey: key, appUserID: userId });
        configured = true;
      } else if (currentUser !== userId) await Purchases.logIn(userId);
      currentUser = userId;
    });
  return identityQueue;
}
export async function clearPurchasesIdentity() {
  await identityQueue.catch(() => {});
  if (configured && currentUser) await Purchases.logOut();
  currentUser = null;
}
export async function syncPurchase(api: MobileApi): Promise<Account> {
  let account = await api.request<Account>('/api/billing/revenuecat/sync', 'POST', {});
  // A purchase and its webhook can reach the backend in either order.
  for (let i = 0; !account.billing.active && i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2100));
    account = await api.request<Account>('/api/billing/revenuecat/sync', 'POST', {});
  }
  return account;
}
export async function presentPaywall(api: MobileApi, userId: string) {
  const existing = await api.account();
  if (existing.billing.active) return existing;
  await identifyPurchases(userId);
  await RevenueCatUI.presentPaywall({ displayCloseButton: true });
  return syncPurchase(api);
}
export async function restorePurchases(api: MobileApi, userId: string) {
  await identifyPurchases(userId);
  await Purchases.restorePurchases();
  return syncPurchase(api);
}
