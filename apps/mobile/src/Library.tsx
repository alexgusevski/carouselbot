import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  RefreshControl,
  Alert,
  TextInput,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useApi } from './context';
import { Cover } from './Cover';
import { newProject } from './model.mjs';
import { Button, IconButton, Loading, ErrorNotice, styles as s } from './ui';
import { colors as c } from './theme';
import type { Project } from './types';
export function Library() {
  const api = useApi();
  const [projects, setProjects] = useState<Project[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [query, setQuery] = useState(''),
    [creating, setCreating] = useState(false),
    [folder, setFolder] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await api.list());
      setError('');
    } catch (error: any) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }, [api]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const project = newProject() as Project;
      if (folder) project.folderPath = folder;
      const saved = await api.save(project, 0);
      router.push(`/editor/${saved.id}`);
    } catch (error: any) {
      Alert.alert('Could not create carousel', error.message);
    } finally {
      setCreating(false);
    }
  };
  const remove = (project: Project) =>
    Alert.alert('Delete carousel?', 'This removes the carousel from your account.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.request(
              `/api/projects/${project.id}?expectedRevision=${project.revision}`,
              'DELETE',
            );
            void load();
          } catch (error: any) {
            Alert.alert('Could not delete', error.message);
          }
        },
      },
    ]);
  const folders = [...new Set(projects.map((p) => p.folderPath).filter(Boolean))];
  return (
    <SafeAreaView style={s.screen}>
      <View style={s.header}>
        <View style={s.row}>
          <Ionicons name="albums" size={23} color={c.ink} />
          <Text style={{ fontSize: 20, fontWeight: '700', color: c.ink, letterSpacing: -0.7 }}>
            carouselbot
          </Text>
        </View>
        <IconButton
          name="person-circle-outline"
          label="Your account"
          onPress={() => router.push('/account')}
        />
      </View>
      <View style={{ padding: 22, gap: 18 }}>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <View>
            <Text style={s.title}>Your studio</Text>
            <Text style={[s.muted, { marginTop: 5 }]}>
              {projects.length} {projects.length === 1 ? 'carousel' : 'carousels'} · synced across
              your devices
            </Text>
          </View>
          <IconButton
            name="add-circle"
            label="Create carousel"
            disabled={creating}
            onPress={() => void create()}
          />
        </View>
        <TextInput
          accessibilityLabel="Search carousels"
          placeholder="Find a carousel"
          placeholderTextColor={c.muted}
          value={query}
          onChangeText={setQuery}
          style={s.input}
        />
        {folders.length > 0 && (
          <View style={[s.row, { flexWrap: 'wrap' }]}>
            {[null, ...folders].map((path) => (
              <Pressable
                key={path || 'all'}
                onPress={() => setFolder(path || null)}
                style={{
                  padding: 10,
                  backgroundColor: folder === path ? c.accent : c.white,
                  borderRadius: 12,
                }}
              >
                <Text style={{ color: c.ink }}>{path?.split('/').at(-1) || 'All'}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
      {error ? (
        <ErrorNotice message={error} retry={() => void load()} />
      ) : loading && !projects.length ? (
        <Loading />
      ) : (
        <FlatList
          data={projects.filter(
            (p) =>
              p.name.toLowerCase().includes(query.toLowerCase()) &&
              (!folder || p.folderPath === folder),
          )}
          numColumns={2}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 25, flexGrow: 1 }}
          columnWrapperStyle={{ gap: 15 }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.name}`}
              onPress={() => router.push(`/editor/${item.id}`)}
              onLongPress={() => remove(item)}
              style={{ width: '48%', marginBottom: 24 }}
            >
              <View style={{ aspectRatio: 0.72, borderRadius: 18, overflow: 'hidden' }}>
                <Cover slide={item.slides[0]} />
                <View
                  style={{
                    position: 'absolute',
                    bottom: 10,
                    right: 10,
                    paddingVertical: 5,
                    paddingHorizontal: 8,
                    backgroundColor: '#FFFFFFE8',
                    borderRadius: 8,
                  }}
                >
                  <Text style={{ color: c.ink, fontSize: 12 }}>{item.slides.length} slides</Text>
                </View>
              </View>
              <Text
                numberOfLines={1}
                style={{ color: c.ink, fontSize: 16, fontWeight: '600', marginTop: 10 }}
              >
                {item.name}
              </Text>
              <Text style={[s.muted, { fontSize: 12, marginTop: 4 }]}>
                {new Date(item.updatedAt).toLocaleDateString()}
              </Text>
            </Pressable>
          )}
          ListEmptyComponent={
            <View
              style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                padding: 28,
                gap: 16,
              }}
            >
              <Ionicons name="albums-outline" size={52} color={c.accentInk} />
              <Text style={{ fontSize: 25, fontWeight: '600', color: c.ink }}>
                Start with an idea.
              </Text>
              <Text style={[s.muted, { textAlign: 'center', lineHeight: 21 }]}>
                Add your photos, write a prompt, and watch your carousel take shape.
              </Text>
              <Button
                label="Create a carousel"
                icon="add"
                disabled={creating}
                onPress={() => void create()}
              />
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}
