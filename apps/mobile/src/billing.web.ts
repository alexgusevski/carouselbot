import type { Account } from './types';
import type { MobileApi } from './api';
export async function identifyPurchases(_userId: string) {
  throw new Error('Open the iOS or Android app to manage app purchases.');
}
export async function clearPurchasesIdentity() {}
export async function presentPaywall(_api: MobileApi, _userId: string): Promise<Account> {
  throw new Error('Subscribe in the native app or at carousel.bot.');
}
export async function restorePurchases(_api: MobileApi, _userId: string): Promise<Account> {
  throw new Error('Restore purchases in the iOS or Android app.');
}
