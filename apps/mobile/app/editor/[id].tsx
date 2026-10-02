import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useApi } from '../../src/context';
import { EditorScreen } from '../../src/EditorScreen';
export default function Editor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <EditorScreen api={useApi()} projectId={id} />;
}
