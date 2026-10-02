import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { useAuth } from '@clerk/expo';
import { MobileApi } from './api';
import { clearPurchasesIdentity, identifyPurchases } from './billing';
const Context = createContext<MobileApi | null>(null);
export function ApiProvider({ children }: React.PropsWithChildren) {
  const { getToken, userId } = useAuth();
  const api = useMemo(() => new MobileApi(() => getToken()), [getToken, userId]);
  useEffect(() => {
    if (userId) identifyPurchases(userId).catch(() => {});
    return () => api.clearMedia();
  }, [api, userId]);
  useEffect(() => {
    if (!userId) clearPurchasesIdentity().catch(() => {});
  }, [userId]);
  return <Context.Provider value={api}>{children}</Context.Provider>;
}
export function useApi() {
  const api = useContext(Context);
  if (!api) throw new Error('API provider is missing');
  return api;
}
