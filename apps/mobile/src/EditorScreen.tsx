import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Alert,
  Modal,
  Image,
  ActivityIndicator,
  AppState,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { Stage, type StageHandle } from './Stage';
import { EditorSession } from './session.mjs';
import {
  blankSlide,
  newProject,
  newText,
  duplicateSlide,
  patchLayer,
  reorderSlide,
  agentStatus,
} from './model.mjs';
import { solidBackgroundDataUrl } from '../../../src/slide-background.mjs';
import { uid, nextLayerZ, slideCanvasDimensions } from '../../../src/editor-model.mjs';
import { ColorPicker, Inspector, NumberField, Options } from './Inspector';
import { colors as c } from './theme';
import { Button, IconButton, Loading, ErrorNotice, styles as s } from './ui';
import { presentPaywall } from './billing';
import { exportMedia } from './exports';
import { saveDraft, loadDraft, clearDraft } from './drafts';
import type { MobileApi } from './api';
import type { Project, Selection, Job, Account, Layer, Slide } from './types';

function demoProject(): Project {
  const project = newProject('A little room to create') as Project;
  const copy = ['A little room\nto create.', 'Start with\none good idea.', 'Make it\nyour own.'];
  const backgrounds = ['#DCEABF', '#E5DFC9', '#D8E4EF'];
  project.slides = backgrounds.map((color, i) => {
    const slide = blankSlide();
    return {
      ...slide,
      name: `Slide ${i + 1}`,
      backgroundColor: color,
      imageData: solidBackgroundDataUrl(color),
      texts: [
        {
          ...newText(slide, copy[i]),
          style: 'plain',
          color: '#1E241B',
          y: 0.3,
          height: 0.35,
          size: 122,
        },
        {
          ...newText(slide, 'CAROUSELBOT'),
          style: 'plain',
          color: '#415E22',
          y: 0.82,
          height: 0.05,
          size: 34,
        },
      ],
    };
  });
  return project as Project;
}
const active = (job: Job | null) => Boolean(job && ['queued', 'running'].includes(job.status));

export function EditorScreen({ api, projectId }: { api: MobileApi | null; projectId: string }) {
  const [session, setSession] = useState<EditorSession | null>(null),
    [, update] = useState(0);
  const [slideId, setSlideId] = useState(''),
    [selection, setSelection] = useState<Selection>(null);
  const [job, setJob] = useState<Job | null>(null),
    [events, setEvents] = useState<any[]>([]),
    [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [prompt, setPrompt] = useState(''),
    [sending, setSending] = useState(false),
    [working, setWorking] = useState(false);
  const [sheet, setSheet] = useState<
      'slide' | 'background' | 'export' | 'rename' | 'assets' | null
    >(null),
    [inspector, setInspector] = useState(false),
    [backgroundMode, setBackgroundMode] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({}),
    [name, setName] = useState(''),
    [folder, setFolder] = useState(''),
    [time, setTime] = useState(0),
    [keyboardUp, setKeyboardUp] = useState(false),
    [foreground, setForeground] = useState(AppState.currentState === 'active');
  const stage = useRef<StageHandle>(null),
    sessionRef = useRef<EditorSession | null>(null),
    user = useRef(''),
    mounted = useRef(true),
    pendingRequest = useRef<{ prompt: string; id: string } | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const project = api ? await api.load(projectId) : demoProject();
      const info = api ? await api.account() : null;
      user.current = info?.userId || '';
      const next = new EditorSession(
        api || { save: async (p: Project, revision: number) => ({ ...p, revision: revision + 1 }) },
        project,
        (current) => {
          if (!mounted.current) return;
          update((value) => value + 1);
          if (api && user.current) {
            try {
              if (current.dirty) saveDraft(user.current, current.project, current.revision);
              else clearDraft(user.current, current.project.id);
            } catch {}
          }
        },
      );
      const chat = api ? await api.request(`/api/projects/${projectId}/chat`) : { job: null };
      next.locked = active(chat.job);
      const draft = api ? await loadDraft(user.current, projectId).catch(() => null) : null;
      if (draft && !next.locked) {
        if (draft.baseRevision === project.revision) next.edit(draft.project);
        else {
          next.project = draft.project;
          next.dirty = true;
          next.conflict = project;
        }
      }
      if (!mounted.current) {
        next.dispose();
        return;
      }
      sessionRef.current?.dispose();
      sessionRef.current = next;
      setSession(next);
      setSlideId(next.project.slides[0]?.id || '');
      setAccount(info);
      setJob(chat.job);
    } catch (error: any) {
      if (mounted.current) setError(error.message);
    }
  }, [api, projectId]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      const current = sessionRef.current;
      if (current?.dirty && api && user.current) {
        try {
          saveDraft(user.current, current.project, current.revision);
        } catch {}
      }
      current?.dispose();
    };
  }, [load]);
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardUp(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardUp(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setForeground(state === 'active');
      if (state !== 'active') sessionRef.current?.flush().catch(() => {});
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!api || !job?.id || !active(job) || !foreground) return;
    let canceled = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api.request(`/api/jobs/${job.id}`);
        if (canceled) return;
        setEvents(result.events || []);
        setJob(result.job);
        const current = sessionRef.current;
        if (current) {
          current.locked = active(result.job);
          if (current.dirty && !current.saving && result.project.revision !== current.revision) {
            current.conflict = result.project;
            current.publish();
          } else current.replaceFromServer(result.project);
        }
        if (active(result.job)) timer = setTimeout(poll, 1500);
        else {
          setNotice('');
          setAccount(await api.account());
          if (Platform.OS !== 'web')
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } catch (error: any) {
        if (!canceled) {
          setNotice(`${error.message} Reconnecting…`);
          timer = setTimeout(poll, 4000);
        }
      }
    };
    void poll();
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [api, job?.id, job?.status, foreground]);
  useEffect(() => {
    if (!api || !foreground || active(job) || !session) return;
    let canceled = false;
    const timer = setInterval(async () => {
      try {
        const chat = await api.request(`/api/projects/${projectId}/chat`);
        if (canceled) return;
        if (active(chat.job)) {
          session.locked = true;
          setJob(chat.job);
          setInspector(false);
        }
        const latest = await api.load(projectId);
        if (canceled) return;
        if (session.dirty && !session.saving && latest.revision !== session.revision) {
          session.conflict = latest;
          session.publish();
        } else if (!session.dirty && !session.saving) session.replaceFromServer(latest);
      } catch {}
    }, 12000);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [api, foreground, job?.status, session, projectId]);

  const project = session?.project as Project | undefined;
  const slide = project?.slides.find((slide) => slide.id === slideId) || project?.slides[0];
  const selected =
    selection &&
    slide &&
    (selection.kind === 'text' ? slide.texts : slide.overlays || []).find(
      (layer) => layer.id === selection.id,
    );
  const locked = active(job) || sending || working || Boolean(session?.conflict);
  const edit = (next: Project) => {
    if (!session || locked) return;
    session.edit(next);
    setNotice('');
  };
  const updateSlide = (patch: Partial<Slide>) => {
    if (project && slide)
      edit({
        ...project,
        slides: project.slides.map((s) => (s.id === slide.id ? { ...s, ...patch } : s)),
      });
  };
  const measurement = useRef(0);
  const patch = (changes: Partial<Layer>) => {
    if (!project || !slide || !selection || !selected || locked) return;
    if (
      selection.kind === 'overlay' &&
      ['cropX', 'cropY', 'cropW', 'cropH'].some((key) => key in changes)
    ) {
      const layer = { ...selected, ...changes },
        asset = project.assets.find((a) => a.id === layer.assetId);
      if (asset) {
        const d = slideCanvasDimensions(project, slide);
        changes.height =
          (((layer.width * d.width) / d.height) * asset.height * (layer.cropH || 1)) /
          (asset.width * (layer.cropW || 1));
      }
    }
    edit(patchLayer(project, slide.id, selection, changes) as Project);
    if (
      selection.kind === 'text' &&
      [
        'text',
        'size',
        'width',
        'fontFamily',
        'fontId',
        'fontWeight',
        'style',
        'backgroundShape',
        'fontStyle',
      ].some((key) => key in changes)
    ) {
      const stamp = ++measurement.current,
        target = selection,
        targetSlideId = slide.id,
        version = session!.version;
      stage.current
        ?.fitText({ ...selected, ...changes })
        .then((height) => {
          const current = sessionRef.current;
          if (
            stamp !== measurement.current ||
            !current ||
            current.locked ||
            current.version !== version
          )
            return;
          current.edit(patchLayer(current.project, targetSlideId, target, { height }), false);
        })
        .catch(() => {});
    }
  };
  const switchSlide = (id: string) => {
    setSlideId(id);
    setSelection(null);
    setTime(0);
    setBackgroundMode(false);
    stage.current?.resetZoom();
  };
  const run = async (operation: () => Promise<void>) => {
    if (working) return;
    setWorking(true);
    try {
      await operation();
    } catch (error: any) {
      Alert.alert('Please try again', error.message);
    } finally {
      if (mounted.current) setWorking(false);
    }
  };

  const send = async () => {
    Keyboard.dismiss();
    if (!api) {
      Alert.alert(
        'Try it with your account',
        'The demo editor works locally. Sign in to use the hosted agent.',
      );
      return;
    }
    if (!prompt.trim() || locked || !session) return;
    if (!account?.billing.active) {
      await run(async () => {
        setAccount(await presentPaywall(api, account?.userId || user.current));
      });
      return;
    }
    Keyboard.dismiss();
    setSending(true);
    setSelection(null);
    setInspector(false);
    setBackgroundMode(false);
    try {
      await session.flush();
      session.locked = true;
      const text = prompt.trim();
      if (pendingRequest.current?.prompt !== text)
        pendingRequest.current = { prompt: text, id: uid() };
      const attachments = (session.project.assets || [])
        .map((a: any) => a.imageData?.match(/^\/api\/assets\/([\w-]+)$/)?.[1])
        .filter(Boolean)
        .slice(-8) as string[];
      const nextJob = await api.startJob(
        session.project,
        text,
        pendingRequest.current!.id,
        attachments,
      );
      setJob(nextJob);
      setEvents([]);
      setPrompt('');
      setNotice('');
      pendingRequest.current = null;
    } catch (error: any) {
      session.locked = false;
      setNotice(error.message);
      if (error.code === 'STALE_PROJECT') {
        session.conflict = error.project;
        session.publish();
      }
    } finally {
      setSending(false);
    }
  };
  const stop = () =>
    void run(async () => {
      if (api && job) {
        await api.request(`/api/jobs/${job.id}/stop`, 'POST', {});
        setNotice('Stopping after the current step…');
      }
    });
  const addText = () => {
    if (!slide || !project) return;
    const text = newText(slide);
    updateSlide({ texts: [...slide.texts, text] });
    setSelection({ kind: 'text', id: text.id });
    setInspector(true);
  };
  const importMedia = (asBackground = false) =>
    void run(async () => {
      if (!slide || !project || !session) return;
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 1,
        allowsMultipleSelection: !asBackground,
        selectionLimit: asBackground ? 1 : 8,
      });
      if (result.canceled) return;
      let next: Project = structuredClone(session.project);
      for (const chosen of result.assets) {
        const mimeType = chosen.mimeType || (chosen.type === 'video' ? 'video/mp4' : 'image/jpeg');
        const file =
          Platform.OS === 'web'
            ? {
                size: chosen.fileSize || 0,
                base64: async () => {
                  const blob = await (await fetch(chosen.uri)).blob();
                  return new Promise<string>((resolve) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result).split(',')[1]);
                    reader.readAsDataURL(blob);
                  });
                },
              }
            : new (require('expo-file-system').File)(chosen.uri);
        if (file.size > 20 * 1024 * 1024) throw new Error('Choose a file smaller than 20 MB.');
        const uploaded = api
          ? await api.upload(chosen.uri, chosen.fileName || 'Photo', mimeType)
          : { id: uid(), url: `data:${mimeType};base64,${await file.base64()}` };
        const asset = {
          id: uploaded.id,
          name: chosen.fileName || 'Photo',
          width: chosen.width,
          height: chosen.height,
          ...(chosen.type === 'video'
            ? {
                videoData: uploaded.url,
                duration: Math.min(120, (chosen.duration || 5000) / 1000),
                imageData: solidBackgroundDataUrl('#111111'),
              }
            : { imageData: uploaded.url }),
        };
        const target = next.slides.find((s) => s.id === slide.id)!;
        if (asBackground)
          Object.assign(target, {
            ...asset,
            id: target.id,
            texts: target.texts,
            overlays: target.overlays,
            backgroundColor: undefined,
            imageScale: 1,
            imageX: 0,
            imageY: 0,
            ...(chosen.type !== 'video' ? { videoData: undefined, duration: undefined } : {}),
          });
        else {
          next.assets.push(asset);
          const d = slideCanvasDimensions(next, target);
          const overlay = {
            id: uid(),
            assetId: asset.id,
            x: 0.15,
            y: 0.2,
            width: 0.7,
            height: (((0.7 * d.width) / d.height) * asset.height) / asset.width,
            rotation: 0,
            z: nextLayerZ(target),
            cropX: 0,
            cropY: 0,
            cropW: 1,
            cropH: 1,
          };
          target.overlays = [...(target.overlays || []), overlay];
          setSelection({ kind: 'overlay', id: overlay.id });
        }
      }
      session.edit(next);
      setSheet(null);
    });
  const importFont = () =>
    void run(async () => {
      if (!project || !session) return;
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const file = result.assets[0];
      if (!/\.(ttf|otf|woff2?)$/i.test(file.name))
        throw new Error('Choose a TTF, OTF, WOFF or WOFF2 font.');
      const id = uid(),
        family = file.name.replace(/\.[^.]+$/, '');
      if ((file.size || 0) > 20 * 1024 * 1024) throw new Error('Choose a font smaller than 20 MB.');
      const mime = `font/${file.name.split('.').pop()!.toLowerCase()}`;
      if (api) {
        const uploaded = await api.upload(file.uri, file.name, mime);
        session.edit({
          ...session.project,
          fonts: [
            ...(session.project.fonts || []),
            {
              id,
              family,
              fullName: family,
              source: 'local',
              weight: 700,
              style: 'normal',
              cssFamily: `carousel-font-${id}`,
              fontData: uploaded.url,
            },
          ],
        });
        return;
      }
      const base64 =
        Platform.OS === 'web'
          ? await new Promise<string>(async (resolve, reject) => {
              try {
                const blob = await (await fetch(file.uri)).blob();
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result).split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              } catch (error) {
                reject(error);
              }
            })
          : await new (require('expo-file-system').File)(file.uri).base64();
      const fontData = `data:${mime};base64,${base64}`;
      session.edit({
        ...session.project,
        fonts: [
          ...(session.project.fonts || []),
          {
            id,
            family,
            fullName: family,
            source: 'local',
            weight: 700,
            style: 'normal',
            cssFamily: `carousel-font-${id}`,
            fontData,
          },
        ],
      });
    });
  const duplicateLayer = () => {
    if (!project || !slide || !selection || !selected) return;
    const copy = {
      ...structuredClone(selected),
      id: uid(),
      x: selected.x + 0.03,
      y: selected.y + 0.03,
      z: nextLayerZ(slide),
    };
    updateSlide(
      selection.kind === 'text'
        ? { texts: [...slide.texts, copy] }
        : { overlays: [...slide.overlays, copy] },
    );
    setSelection({ ...selection, id: copy.id });
  };
  const removeLayer = () => {
    if (!slide || !selection) return;
    updateSlide(
      selection.kind === 'text'
        ? { texts: slide.texts.filter((t) => t.id !== selection.id) }
        : { overlays: slide.overlays.filter((t) => t.id !== selection.id) },
    );
    setSelection(null);
    setInspector(false);
  };
  const exportOne = (format: 'png' | 'mp4', destination: 'share' | 'photos') =>
    void run(async () => {
      if (!project || !slide) return;
      setSheet(null);
      Keyboard.dismiss();
      await session?.flush();
      const data = await stage.current!.export(format);
      await exportMedia(
        data,
        `${project.name}-${project.slides.indexOf(slide) + 1}`,
        format,
        destination,
      );
      setNotice(destination === 'photos' ? 'Saved to Photos' : 'Ready to share');
    });
  const exportAll = () =>
    void run(async () => {
      if (!project) return;
      setSheet(null);
      Keyboard.dismiss();
      await session?.flush();
      for (let i = 0; i < project.slides.length; i++) {
        const item = project.slides[i];
        setNotice(`Exporting slide ${i + 1} of ${project.slides.length}…`);
        const hydrated = api ? await api.hydrate(project, item.id) : project;
        const data = await stage.current!.export('png', hydrated, item.id);
        await exportMedia(data, `${project.name}-${i + 1}`, 'png', 'photos');
      }
      setNotice('All slides saved to Photos');
    });
  const leave = () => {
    if (session?.dirty) {
      Alert.alert(
        'Your changes are saved on this device',
        'They have not synced yet. Keep editing or return to your studio?',
        [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Return to studio', onPress: () => router.back() },
        ],
      );
    } else router.back();
  };
  const onStageMessage = (message: any) => {
    if (message.type === 'selection') {
      if (!locked) setSelection(message.selection);
    }
    if (message.type === 'editText') {
      if (!locked) setInspector(true);
    }
    if (message.type === 'painted' && message.thumbnail)
      setThumbnails((old) =>
        old[message.slideId] === message.thumbnail
          ? old
          : { ...old, [message.slideId]: message.thumbnail },
      );
    if (
      message.type === 'layerPatch' &&
      sessionRef.current &&
      !locked &&
      message.revision === sessionRef.current.revision &&
      message.slideId === slide?.id
    )
      sessionRef.current.edit(
        patchLayer(sessionRef.current.project, message.slideId, message.selection, message.patch),
      );
    if (
      message.type === 'backgroundPatch' &&
      !locked &&
      message.revision === sessionRef.current?.revision
    )
      updateSlide(message.patch);
    if (message.type === 'error') setNotice(message.message);
  };

  if (error)
    return (
      <SafeAreaView style={s.screen}>
        <View style={s.header}>
          <IconButton name="arrow-back" label="Back" onPress={() => router.back()} />
        </View>
        <ErrorNotice message={error} retry={() => void load()} />
      </SafeAreaView>
    );
  if (!project || !slide || !session) return <Loading />;
  return (
    <SafeAreaView style={s.screen} edges={['top', 'left', 'right', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.header}>
          <IconButton name="chevron-back" label="Back to studio" onPress={leave} />
          <Pressable
            onPress={() => {
              setName(project.name);
              setFolder(project.folderPath || '');
              setSheet('rename');
            }}
            style={{ flex: 1 }}
          >
            <Text
              numberOfLines={1}
              style={{ textAlign: 'center', color: c.ink, fontSize: 16, fontWeight: '600' }}
            >
              {project.name}
            </Text>
            <Text
              style={{
                textAlign: 'center',
                fontSize: 11,
                marginTop: 2,
                color: session.error ? c.danger : c.muted,
              }}
            >
              {api
                ? session.conflict
                  ? 'Changed on another device'
                  : session.saving
                    ? 'Saving…'
                    : session.dirty
                      ? 'Saved on this device'
                      : 'All changes saved'
                : 'Demo · try it by hand'}
            </Text>
          </Pressable>
          <IconButton
            name="share-outline"
            label="Export carousel"
            onPress={() => setSheet('export')}
            disabled={locked}
          />
        </View>
        {session.conflict && (
          <View
            style={{
              paddingHorizontal: 20,
              paddingVertical: 10,
              backgroundColor: '#F4E6DC',
              gap: 10,
            }}
          >
            <Text style={{ color: c.ink, fontSize: 14 }}>
              This carousel changed elsewhere. Your edits are kept on this device.
            </Text>
            <View style={s.row}>
              <Button
                label="Load latest"
                secondary
                onPress={() => {
                  session.reload(session.conflict);
                  switchSlide(session.project.slides[0]?.id);
                }}
              />
              <Button
                label="Save my copy"
                secondary
                onPress={() =>
                  void run(async () => {
                    if (!api) return;
                    const copy = {
                      ...session.project,
                      id: uid(),
                      name: `${session.project.name} copy`,
                      revision: 0,
                    };
                    const saved = await api.save(copy, 0);
                    clearDraft(user.current, projectId);
                    router.replace(`/editor/${saved.id}`);
                  })
                }
              />
            </View>
          </View>
        )}
        <Stage
          ref={stage}
          project={project}
          slideId={slide.id}
          selection={selection}
          api={api}
          locked={locked}
          backgroundMode={backgroundMode}
          onMessage={onStageMessage}
          time={time}
        />
        {backgroundMode && (
          <View
            style={[s.row, { paddingHorizontal: 15, paddingVertical: 5, backgroundColor: c.white }]}
          >
            <Text style={[s.muted, { flex: 1 }]}>Drag to position the background</Text>
            <IconButton
              name="remove"
              label="Zoom background out"
              onPress={() =>
                updateSlide({ imageScale: Math.max(1, (slide.imageScale || 1) - 0.1) })
              }
            />
            <Text style={{ color: c.ink }}>{(slide.imageScale || 1).toFixed(1)}×</Text>
            <IconButton
              name="add"
              label="Zoom background in"
              onPress={() =>
                updateSlide({ imageScale: Math.min(5, (slide.imageScale || 1) + 0.1) })
              }
            />
            <IconButton
              name="checkmark"
              label="Done positioning background"
              onPress={() => setBackgroundMode(false)}
            />
          </View>
        )}
        {(slide.videoData ||
          slide.overlays.some(
            (o) => project.assets.find((a) => a.id === o.assetId)?.videoData,
          )) && (
          <View style={[s.row, { paddingHorizontal: 20, paddingVertical: 5 }]}>
            <IconButton
              name="play-skip-back"
              label="Previous video frame"
              onPress={() => setTime(Math.max(0, time - 0.5))}
            />
            <Text style={{ flex: 1, color: c.muted, textAlign: 'center' }}>
              {time.toFixed(1)}s / {(slide.duration || 5).toFixed(1)}s
            </Text>
            <IconButton
              name="play-skip-forward"
              label="Next video frame"
              onPress={() => setTime(Math.min(slide.duration || 5, time + 0.5))}
            />
          </View>
        )}
        {!keyboardUp && (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flexGrow: 0, maxHeight: 91 }}
              contentContainerStyle={{ paddingHorizontal: 19, paddingVertical: 12, gap: 10 }}
            >
              {project.slides.map((item, index) => (
                <Pressable
                  accessibilityLabel={`Slide ${index + 1}`}
                  accessibilityRole="button"
                  key={item.id}
                  onPress={() => switchSlide(item.id)}
                  onLongPress={() => {
                    switchSlide(item.id);
                    setSheet('slide');
                  }}
                  style={{
                    width: 38,
                    height: 65,
                    borderRadius: 8,
                    borderWidth: item.id === slide.id ? 2 : 1,
                    borderColor: item.id === slide.id ? c.accentInk : c.line,
                    overflow: 'hidden',
                    backgroundColor: item.backgroundColor || c.white,
                  }}
                >
                  {thumbnails[item.id] ? (
                    <Image
                      source={{ uri: thumbnails[item.id] }}
                      style={{ width: '100%', height: '100%' }}
                    />
                  ) : (
                    <Text
                      numberOfLines={3}
                      style={{ fontSize: 7, color: c.ink, padding: 4, marginTop: 6 }}
                    >
                      {item.texts[0]?.text || 'Blank'}
                    </Text>
                  )}
                  <View
                    style={{
                      position: 'absolute',
                      bottom: 2,
                      right: 3,
                      backgroundColor: '#FFFFFFCC',
                      borderRadius: 3,
                      paddingHorizontal: 2,
                    }}
                  >
                    <Text style={{ fontSize: 9, color: c.ink }}>{index + 1}</Text>
                  </View>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add slide"
                disabled={locked}
                onPress={() => {
                  const next = blankSlide(project);
                  edit({ ...project, slides: [...project.slides, next] });
                  switchSlide(next.id);
                }}
                style={{
                  width: 39,
                  height: 65,
                  justifyContent: 'center',
                  alignItems: 'center',
                  borderRadius: 8,
                  borderWidth: 1,
                  borderStyle: 'dashed',
                  borderColor: c.muted,
                }}
              >
                <Ionicons name="add" size={19} color={c.muted} />
              </Pressable>
            </ScrollView>
            <View
              style={[
                s.row,
                {
                  justifyContent: 'space-between',
                  paddingHorizontal: 14,
                  borderTopWidth: 1,
                  borderTopColor: c.line,
                  paddingVertical: 2,
                },
              ]}
            >
              <IconButton
                name="arrow-undo-outline"
                label="Undo"
                disabled={locked || (!session.past.length && !job?.canUndo)}
                onPress={() => {
                  if (session.past.length) session.undo();
                  else if (api && job?.canUndo)
                    void run(async () => {
                      await session.flush();
                      const result = await api.request(`/api/jobs/${job.id}/undo`, 'POST', {
                        expectedRevision: session.revision,
                      });
                      session.reload(result.project);
                      setJob(result.job);
                    });
                }}
              />
              <IconButton
                name="arrow-redo-outline"
                label="Redo"
                disabled={locked || !session.future.length}
                onPress={() => session.redo()}
              />
              <IconButton name="text" label="Add text" disabled={locked} onPress={addText} />
              <IconButton
                name="images-outline"
                label="Add photos"
                disabled={locked}
                onPress={() => setSheet('assets')}
              />
              <IconButton
                name={selection ? 'options-outline' : 'color-palette-outline'}
                label={selection ? 'Edit selected layer' : 'Slide background'}
                disabled={locked}
                onPress={() => (selection ? setInspector(true) : setSheet('background'))}
              />
              <IconButton
                name="ellipsis-horizontal"
                label="Slide actions"
                disabled={locked}
                onPress={() => setSheet('slide')}
              />
            </View>
          </>
        )}
        <View style={{ paddingHorizontal: 17, paddingTop: 6, paddingBottom: 6, gap: 7 }}>
          <View style={[s.row, { paddingHorizontal: 4, height: 23 }]}>
            {active(job) || sending || working ? (
              <ActivityIndicator size="small" color={c.accentInk} />
            ) : (
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: session.error ? c.danger : c.accentInk,
                }}
              />
            )}
            <Text
              accessibilityLiveRegion="polite"
              numberOfLines={1}
              style={{ color: c.muted, fontSize: 12, flex: 1 }}
            >
              {notice ||
                (session.error ? `${session.error} · tap to retry` : agentStatus(job, events))}
            </Text>
            {active(job) ? (
              <Pressable accessibilityRole="button" onPress={stop} style={{ padding: 5 }}>
                <Text style={{ color: c.ink, fontSize: 12, fontWeight: '600' }}>Stop</Text>
              </Pressable>
            ) : (
              session.error && (
                <Pressable onPress={() => void session.flush().catch(() => {})}>
                  <Text style={{ color: c.ink }}>Retry save</Text>
                </Pressable>
              )
            )}
          </View>
          <View
            style={[
              s.row,
              {
                backgroundColor: c.white,
                borderRadius: 23,
                paddingLeft: 17,
                paddingRight: 5,
                borderWidth: 1,
                borderColor: c.line,
                gap: 4,
              },
            ]}
          >
            <TextInput
              accessibilityLabel="Ask the agent to edit your carousel"
              value={prompt}
              onChangeText={setPrompt}
              placeholder="What would you like to change?"
              placeholderTextColor={c.muted}
              editable={!locked}
              multiline
              submitBehavior="submit"
              returnKeyType="send"
              onSubmitEditing={() => void send()}
              maxLength={12000}
              style={{
                flex: 1,
                fontSize: 15,
                color: c.ink,
                minHeight: 48,
                maxHeight: 120,
                paddingVertical: 13,
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send to agent"
              disabled={locked || !prompt.trim()}
              onPress={() => void send()}
              style={{
                width: 38,
                height: 38,
                borderRadius: 19,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: prompt.trim() && !locked ? c.ink : c.stage,
              }}
            >
              <Ionicons
                name="arrow-up"
                size={21}
                color={prompt.trim() && !locked ? c.white : c.muted}
              />
            </Pressable>
          </View>
        </View>
        <Inspector
          visible={inspector}
          close={() => setInspector(false)}
          layer={selected || undefined}
          selection={selection}
          project={project}
          patch={patch}
          duplicate={duplicateLayer}
          remove={removeLayer}
          importFont={importFont}
        />
        <Modal
          visible={Boolean(sheet)}
          transparent
          animationType="slide"
          onRequestClose={() => setSheet(null)}
        >
          <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#1E241B55' }}>
            <Pressable
              accessibilityLabel="Close menu"
              onPress={() => setSheet(null)}
              style={{ flex: 1 }}
            />
            <SafeAreaView
              edges={['bottom']}
              style={{
                backgroundColor: c.paper,
                borderTopLeftRadius: 28,
                borderTopRightRadius: 28,
                maxHeight: '85%',
              }}
            >
              <View style={s.header}>
                <Text style={{ fontSize: 22, color: c.ink, fontWeight: '600' }}>
                  {sheet === 'slide'
                    ? 'This slide'
                    : sheet === 'background'
                      ? 'Background'
                      : sheet === 'export'
                        ? 'Ready to share'
                        : sheet === 'assets'
                          ? 'Your images'
                          : 'Carousel details'}
                </Text>
                <IconButton name="close" label="Close menu" onPress={() => setSheet(null)} />
              </View>
              <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ padding: 22, gap: 13 }}
              >
                {sheet === 'slide' && (
                  <>
                    <Text style={s.muted}>Slide format</Text>
                    <Options
                      options={['9:16', '4:5', '1:1', '3:4', '2:3', '4:3', '16:9']}
                      value={slide.aspectRatio || project.aspectRatio}
                      change={(aspectRatio) => {
                        const next = { ...slide, aspectRatio };
                        updateSlide({
                          aspectRatio,
                          ...(slide.backgroundColor
                            ? {
                                imageData: solidBackgroundDataUrl(
                                  slide.backgroundColor,
                                  project,
                                  next,
                                ),
                              }
                            : {}),
                        });
                      }}
                    />
                    <Button
                      label="Duplicate slide"
                      secondary
                      icon="copy-outline"
                      onPress={() => {
                        const copy = duplicateSlide(slide);
                        const slides = [...project.slides];
                        slides.splice(slides.indexOf(slide) + 1, 0, copy);
                        edit({ ...project, slides });
                        switchSlide(copy.id);
                        setSheet(null);
                      }}
                    />
                    <View style={s.row}>
                      <Button
                        label="Move left"
                        secondary
                        disabled={project.slides.indexOf(slide) === 0}
                        onPress={() => edit(reorderSlide(project, slide.id, -1))}
                      />
                      <Button
                        label="Move right"
                        secondary
                        disabled={project.slides.indexOf(slide) === project.slides.length - 1}
                        onPress={() => edit(reorderSlide(project, slide.id, 1))}
                      />
                    </View>
                    {slide.videoData && (
                      <NumberField
                        label="Video duration (seconds)"
                        value={slide.duration || 5}
                        min={0.5}
                        max={120}
                        change={(duration) => updateSlide({ duration })}
                      />
                    )}
                    <Button
                      label="Delete slide"
                      secondary
                      icon="trash-outline"
                      disabled={project.slides.length < 2}
                      onPress={() => {
                        const slides = project.slides.filter((s) => s.id !== slide.id);
                        edit({ ...project, slides });
                        switchSlide(slides[0].id);
                        setSheet(null);
                      }}
                    />
                  </>
                )}
                {sheet === 'background' && (
                  <>
                    <ColorPicker
                      value={slide.backgroundColor || '#F1EFE7'}
                      onChange={(backgroundColor) =>
                        updateSlide({
                          backgroundColor,
                          imageData: solidBackgroundDataUrl(backgroundColor, project, slide),
                          videoData: undefined,
                          imageScale: 1,
                          imageX: 0,
                          imageY: 0,
                        })
                      }
                    />
                    <Button
                      label="Choose a photo or video"
                      secondary
                      icon="image-outline"
                      onPress={() => importMedia(true)}
                    />
                    <Button
                      label="Position and zoom"
                      secondary
                      icon="move-outline"
                      onPress={() => {
                        setSheet(null);
                        setBackgroundMode(true);
                        setSelection(null);
                      }}
                    />
                  </>
                )}
                {sheet === 'assets' && (
                  <>
                    <Button label="Add photos or videos" icon="add" onPress={() => importMedia()} />
                    {project.assets.map((asset) => (
                      <Button
                        key={asset.id}
                        label={asset.name || 'Image'}
                        secondary
                        onPress={() => {
                          const d = slideCanvasDimensions(project, slide);
                          const layer = {
                            id: uid(),
                            assetId: asset.id,
                            x: 0.15,
                            y: 0.2,
                            width: 0.7,
                            height: (((0.7 * d.width) / d.height) * asset.height) / asset.width,
                            z: nextLayerZ(slide),
                          };
                          updateSlide({ overlays: [...slide.overlays, layer] });
                          setSelection({ kind: 'overlay', id: layer.id });
                          setSheet(null);
                        }}
                      />
                    ))}
                  </>
                )}
                {sheet === 'export' && (
                  <>
                    <Text style={[s.muted, { marginBottom: 5 }]}>
                      Full-resolution slides, ready for your next post.
                    </Text>
                    <Button
                      label="Save all slides to Photos"
                      icon="albums-outline"
                      onPress={exportAll}
                    />
                    <Button
                      label="Save this slide to Photos"
                      secondary
                      icon="download-outline"
                      onPress={() => exportOne('png', 'photos')}
                    />
                    <Button
                      label="Share this slide"
                      secondary
                      icon="share-outline"
                      onPress={() => exportOne('png', 'share')}
                    />
                    {(slide.videoData ||
                      slide.overlays.some(
                        (o) => project.assets.find((a) => a.id === o.assetId)?.videoData,
                      )) && (
                      <Button
                        label="Export video (MP4)"
                        secondary
                        icon="videocam-outline"
                        onPress={() => exportOne('mp4', 'share')}
                      />
                    )}
                  </>
                )}
                {sheet === 'rename' && (
                  <>
                    <TextInput
                      accessibilityLabel="Carousel name"
                      style={s.input}
                      value={name}
                      onChangeText={setName}
                      maxLength={200}
                    />
                    <TextInput
                      accessibilityLabel="Folder"
                      style={s.input}
                      value={folder}
                      onChangeText={setFolder}
                      placeholder="Folder (optional)"
                      placeholderTextColor={c.muted}
                    />
                    <Button
                      label="Save details"
                      onPress={() => {
                        edit({
                          ...project,
                          name: name.trim() || 'Untitled carousel',
                          folderPath: folder.trim() || undefined,
                        });
                        setSheet(null);
                      }}
                    />
                  </>
                )}
              </ScrollView>
            </SafeAreaView>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
