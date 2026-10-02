import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { View, ActivityIndicator, Platform } from 'react-native';
import type { WebViewProps } from 'react-native-webview';
const NativeWebView: React.ComponentType<WebViewProps & { ref: React.Ref<any> }> =
  Platform.OS === 'web' ? () => null : require('react-native-webview').WebView;
import html from './generated/stage';
import type { Project, Selection, Layer } from './types';
import type { MobileApi } from './api';
import { colors } from './theme';
export type StageHandle = {
  export: (format: 'png' | 'mp4', project?: Project, slideId?: string) => Promise<string>;
  resetZoom: () => void;
  fitText: (text: Layer) => Promise<number>;
};
export const Stage = forwardRef<
  StageHandle,
  {
    project: Project;
    slideId: string;
    selection: Selection;
    locked: boolean;
    backgroundMode: boolean;
    api: MobileApi | null;
    onMessage: (message: any) => void;
    time?: number;
  }
>((props, ref) => {
  const web = useRef<{ injectJavaScript: (script: string) => void } | null>(null),
    iframe = useRef<any>(null);
  const [ready, setReady] = useState(false),
    [loading, setLoading] = useState(true);
  const requests = useRef(
    new Map<
      string,
      {
        resolve: (data: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const send = (message: any) => {
    if (Platform.OS === 'web') iframe.current?.contentWindow?.CarouselStage?.receive(message);
    else
      web.current?.injectJavaScript(
        `window.CarouselStage?.receive(${JSON.stringify(message)});true;`,
      );
  };
  const receive = (message: any) => {
    if (message.type === 'ready') setReady(true);
    if (message.type === 'painted') setLoading(false);
    const pending = message.requestId && requests.current.get(message.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      requests.current.delete(message.requestId);
      if (message.type === 'error') pending.reject(new Error(message.message));
      else pending.resolve(message.data);
    }
    props.onMessage(message);
  };
  const receiveRef = useRef(receive);
  receiveRef.current = receive;
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const listener = (event: MessageEvent) => {
      if (event.source === iframe.current?.contentWindow && typeof event.data === 'string') {
        try {
          receiveRef.current(JSON.parse(event.data));
        } catch {}
      }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);
  useEffect(() => {
    if (!ready) return;
    let canceled = false;
    setLoading(true);
    (async () => {
      try {
        const project = props.api
          ? await props.api.hydrate(props.project, props.slideId)
          : props.project;
        if (!canceled)
          send({
            type: 'load',
            project,
            slideId: props.slideId,
            selection: props.selection,
            locked: props.locked,
            backgroundMode: props.backgroundMode,
          });
      } catch (error: any) {
        if (!canceled) {
          setLoading(false);
          props.onMessage({ type: 'error', message: error.message });
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [ready, props.project, props.slideId]);
  useEffect(() => {
    if (ready)
      send({
        type: 'state',
        selection: props.selection,
        locked: props.locked,
        backgroundMode: props.backgroundMode,
      });
  }, [ready, props.selection, props.locked, props.backgroundMode]);
  useEffect(() => {
    if (ready) send({ type: 'playhead', time: props.time || 0 });
  }, [ready, props.time]);
  useEffect(
    () => () => {
      requests.current.forEach((p) => {
        clearTimeout(p.timer);
        p.reject(new Error('Editor closed.'));
      });
      requests.current.clear();
    },
    [],
  );
  useImperativeHandle(ref, () => ({
    resetZoom: () => send({ type: 'resetZoom' }),
    fitText: (text) =>
      new Promise((resolve, reject) => {
        if (!ready) {
          reject(new Error('Slide is loading'));
          return;
        }
        const requestId = `measure-${Date.now()}-${Math.random()}`;
        requests.current.set(requestId, {
          resolve,
          reject,
          timer: setTimeout(() => {
            requests.current.delete(requestId);
            reject(new Error('Text layout timed out'));
          }, 5000),
        });
        send({ type: 'measureText', text, requestId });
      }),
    export: (format, project, slideId) =>
      new Promise((resolve, reject) => {
        if (!ready || loading) {
          reject(new Error('Wait for the slide to finish loading.'));
          return;
        }
        const requestId = `${Date.now()}-${Math.random()}`;
        requests.current.set(requestId, {
          resolve,
          reject,
          timer: setTimeout(
            () => {
              requests.current.delete(requestId);
              reject(new Error('Export timed out. Please retry.'));
            },
            format === 'mp4' ? 180000 : 30000,
          ),
        });
        send({ type: 'export', format, requestId, project, slideId });
      }),
  }));
  const webHtml = html.replace(
    '<script>',
    '<script>window.ReactNativeWebView={postMessage:(s)=>parent.postMessage(s,"*")};',
  );
  return (
    <View style={{ flex: 1, backgroundColor: colors.stage }}>
      {Platform.OS === 'web' ? (
        React.createElement('iframe', {
          ref: iframe,
          srcDoc: webHtml,
          title: 'Carousel editor',
          style: { border: 0, width: '100%', height: '100%' },
        })
      ) : (
        <NativeWebView
          ref={web}
          source={{ html, baseUrl: 'about:blank' }}
          originWhitelist={['about:blank']}
          onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
          onMessage={(event) => {
            try {
              receiveRef.current(JSON.parse(event.nativeEvent.data));
            } catch {}
          }}
          onError={(event) =>
            props.onMessage({ type: 'error', message: event.nativeEvent.description })
          }
          javaScriptEnabled
          scrollEnabled={false}
          bounces={false}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          allowFileAccess={false}
          allowUniversalAccessFromFileURLs={false}
          setSupportMultipleWindows={false}
          style={{ backgroundColor: colors.stage }}
        />
      )}
      {loading && (
        <ActivityIndicator
          pointerEvents="none"
          color={colors.accentInk}
          style={{ position: 'absolute', alignSelf: 'center', top: '45%' }}
        />
      )}
    </View>
  );
});
