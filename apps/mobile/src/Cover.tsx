import React, { useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';
import type { Slide } from './types';
import { useAuth } from '@clerk/expo';
import { apiUrl } from './api';
import { colors as c } from './theme';
export function Cover({ slide }: { slide?: Slide }) {
  const { getToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getToken()
      .then((t) => {
        if (live) setToken(t);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [slide?.imageData]);
  const source = slide?.imageData;
  const privateMedia = source?.startsWith('/api/assets/');
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: slide?.backgroundColor || '#E5DFC9',
        padding: 16,
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {source && !source.startsWith('data:image/svg') && (!privateMedia || token) && (
        <Image
          source={{
            uri: privateMedia ? apiUrl + source : source,
            ...(privateMedia
              ? { headers: { authorization: `Bearer ${token}`, 'x-carousel-client': 'mobile' } }
              : {}),
          }}
          style={{ position: 'absolute', width: '100%', height: '100%' }}
          resizeMode="cover"
        />
      )}
      <Text
        numberOfLines={5}
        style={{
          fontSize: 22,
          lineHeight: 27,
          fontWeight: '700',
          letterSpacing: -0.6,
          color: slide?.texts?.[0]?.color || c.ink,
          textAlign: 'center',
          ...(slide?.texts?.[0]?.style === 'boxed'
            ? {
                backgroundColor: slide.texts[0].background === 'white' ? '#FFFFFF' : '#111111',
                padding: 8,
                borderRadius: 5,
              }
            : {}),
        }}
      >
        {slide?.texts?.[0]?.text || 'A fresh start.'}
      </Text>
    </View>
  );
}
