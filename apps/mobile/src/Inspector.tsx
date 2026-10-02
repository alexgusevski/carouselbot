import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors as c } from './theme';
import { Button, IconButton, styles as s } from './ui';
import type { Layer, Project, Selection } from './types';
const palette = [
  '#FFFFFF',
  '#111111',
  '#F1EFE7',
  '#DCEABF',
  '#E5DFC9',
  '#D8E4EF',
  '#EBCFCA',
  '#FFE45E',
  '#FE2C55',
  '#4D7CFE',
];
export function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [custom, setCustom] = useState(value);
  useEffect(() => setCustom(value), [value]);
  return (
    <View style={{ gap: 10 }}>
      <View style={[s.row, { flexWrap: 'wrap' }]}>
        {palette.map((color) => (
          <Pressable
            accessibilityLabel={`Color ${color}`}
            accessibilityRole="button"
            key={color}
            onPress={() => {
              setCustom(color);
              onChange(color);
            }}
            style={{
              width: 37,
              height: 37,
              borderRadius: 19,
              backgroundColor: color,
              borderWidth: value?.toUpperCase() === color ? 3 : 1,
              borderColor: value?.toUpperCase() === color ? c.accentInk : c.line,
            }}
          />
        ))}
      </View>
      <TextInput
        accessibilityLabel="Custom hex color"
        value={custom}
        autoCapitalize="characters"
        maxLength={7}
        onChangeText={(value) => {
          setCustom(value);
          if (/^#[A-Fa-f0-9]{6}$/.test(value)) onChange(value);
        }}
        style={[s.input, { padding: 10 }]}
      />
    </View>
  );
}
export function NumberField({
  label,
  value,
  change,
  step = 1,
  min = -1000,
  max = 1000,
}: {
  label: string;
  value: number;
  change: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100));
  useEffect(() => setDraft(String(Math.round(value * 100) / 100)), [value]);
  const commit = (next: number) => {
    if (Number.isFinite(next)) {
      const n = Math.max(min, Math.min(max, next));
      setDraft(String(Math.round(n * 100) / 100));
      change(n);
    }
  };
  return (
    <View style={{ flex: 1, gap: 7 }}>
      <Text style={s.muted}>{label}</Text>
      <View style={[s.row, { gap: 0, backgroundColor: c.white, borderRadius: 12 }]}>
        <IconButton
          name="remove"
          label={`Decrease ${label}`}
          onPress={() => commit(value - step)}
        />
        <TextInput
          accessibilityLabel={label}
          keyboardType="numbers-and-punctuation"
          selectTextOnFocus
          value={draft}
          onChangeText={setDraft}
          onEndEditing={() => commit(Number(draft))}
          style={{ flex: 1, textAlign: 'center', color: c.ink, fontSize: 15, minWidth: 35 }}
        />
        <IconButton name="add" label={`Increase ${label}`} onPress={() => commit(value + step)} />
      </View>
    </View>
  );
}
export function Options({
  options,
  value,
  change,
}: {
  options: string[];
  value?: string;
  change: (value: string) => void;
}) {
  return (
    <View style={[s.row, { flexWrap: 'wrap' }]}>
      {options.map((option) => (
        <Pressable
          accessibilityRole="button"
          key={option}
          onPress={() => change(option)}
          style={{
            paddingHorizontal: 15,
            paddingVertical: 12,
            backgroundColor: value === option ? c.accent : c.white,
            borderRadius: 12,
          }}
        >
          <Text style={{ color: c.ink, fontSize: 14, textTransform: 'capitalize' }}>{option}</Text>
        </Pressable>
      ))}
    </View>
  );
}
export function Inspector({
  visible,
  close,
  layer,
  selection,
  project,
  patch,
  duplicate,
  remove,
  importFont,
}: {
  visible: boolean;
  close: () => void;
  layer: Layer | undefined;
  selection: Selection;
  project: Project;
  patch: (patch: Partial<Layer>) => void;
  duplicate: () => void;
  remove: () => void;
  importFont: () => void;
}) {
  if (!layer || !selection) return null;
  const isText = selection.kind === 'text';
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <SafeAreaView style={s.screen}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={s.header}>
            <Text style={{ fontSize: 22, fontWeight: '600', color: c.ink }}>
              {isText ? 'Edit text' : 'Edit image'}
            </Text>
            <IconButton name="checkmark" label="Done editing" onPress={close} />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 20, gap: 22, paddingBottom: 40 }}
          >
            {isText && (
              <>
                <TextInput
                  accessibilityLabel="Slide text"
                  multiline
                  value={layer.text || ''}
                  onChangeText={(text) => patch({ text })}
                  style={[s.input, { minHeight: 105, fontSize: 20, textAlignVertical: 'top' }]}
                />
                <Options
                  options={['plain', 'boxed', 'outline']}
                  value={layer.style}
                  change={(style) =>
                    patch({
                      style,
                      ...(style === 'boxed'
                        ? { color: layer.background === 'white' ? '#111111' : '#FFFFFF' }
                        : {}),
                    })
                  }
                />
                {layer.style === 'boxed' && (
                  <>
                    <Options
                      options={['black', 'white']}
                      value={layer.background}
                      change={(background) =>
                        patch({ background, color: background === 'white' ? '#111111' : '#FFFFFF' })
                      }
                    />
                    <Options
                      options={['lines', 'full']}
                      value={layer.backgroundShape || 'lines'}
                      change={(backgroundShape) => patch({ backgroundShape })}
                    />
                  </>
                )}
                <View style={s.row}>
                  <NumberField
                    key={`size-${layer.id}`}
                    label="Size"
                    value={layer.size || 96}
                    min={20}
                    max={300}
                    step={4}
                    change={(size) => patch({ size })}
                  />
                  <NumberField
                    key={`weight-${layer.id}`}
                    label="Weight"
                    value={layer.fontWeight || 700}
                    min={100}
                    max={900}
                    step={100}
                    change={(fontWeight) => patch({ fontWeight })}
                  />
                </View>
                <Options
                  options={['normal', 'italic']}
                  value={layer.fontStyle || 'normal'}
                  change={(fontStyle) => patch({ fontStyle })}
                />
                {layer.style === 'outline' && (
                  <NumberField
                    label="Outline width"
                    value={layer.outlineWidth ?? 12}
                    min={0}
                    max={80}
                    change={(outlineWidth) => patch({ outlineWidth })}
                  />
                )}
                <Options
                  options={['left', 'center', 'right']}
                  value={layer.align || 'center'}
                  change={(align) => patch({ align })}
                />
                <View style={{ gap: 9 }}>
                  <Text style={s.muted}>Font</Text>
                  <Options
                    options={['TikTok Sans', 'Arial', 'Georgia']}
                    value={layer.fontFamily}
                    change={(fontFamily) => patch({ fontFamily, fontId: undefined })}
                  />
                  {project.fonts?.map((font) => (
                    <Button
                      key={font.id}
                      secondary
                      label={font.family || font.name || 'Custom font'}
                      onPress={() => patch({ fontId: font.id, fontFamily: font.family })}
                    />
                  ))}
                  <Button
                    label="Import a font"
                    secondary
                    icon="download-outline"
                    onPress={importFont}
                  />
                </View>
                <Text style={s.muted}>Text color</Text>
                <ColorPicker
                  value={layer.color || '#FFFFFF'}
                  onChange={(color) => patch({ color })}
                />
              </>
            )}
            <View style={s.row}>
              <NumberField
                key={`width-${layer.id}`}
                label="Width %"
                value={layer.width * 100}
                min={4}
                max={240}
                step={5}
                change={(width) => patch({ width: width / 100 })}
              />
              <NumberField
                key={`rotation-${layer.id}`}
                label="Rotation °"
                value={layer.rotation || 0}
                min={-360}
                max={360}
                step={5}
                change={(rotation) => patch({ rotation })}
              />
            </View>
            <NumberField
              label="Height %"
              value={(layer.height || 0.2) * 100}
              min={2}
              max={240}
              step={5}
              change={(height) => patch({ height: height / 100 })}
            />
            <View style={s.row}>
              <NumberField
                key={`x-${layer.id}`}
                label="Left %"
                value={layer.x * 100}
                min={-100}
                max={100}
                step={2}
                change={(x) => patch({ x: x / 100 })}
              />
              <NumberField
                key={`y-${layer.id}`}
                label="Top %"
                value={layer.y * 100}
                min={-100}
                max={100}
                step={2}
                change={(y) => patch({ y: y / 100 })}
              />
            </View>
            {!isText && (
              <>
                <Text style={{ color: c.ink, fontWeight: '600', fontSize: 17 }}>Crop</Text>
                <View style={s.row}>
                  <NumberField
                    label="Crop left %"
                    value={(layer.cropX || 0) * 100}
                    min={0}
                    max={95}
                    step={5}
                    change={(cropX) =>
                      patch({
                        cropX: cropX / 100,
                        cropW: Math.min(layer.cropW || 1, 1 - cropX / 100),
                      })
                    }
                  />
                  <NumberField
                    label="Crop top %"
                    value={(layer.cropY || 0) * 100}
                    min={0}
                    max={95}
                    step={5}
                    change={(cropY) =>
                      patch({
                        cropY: cropY / 100,
                        cropH: Math.min(layer.cropH || 1, 1 - cropY / 100),
                      })
                    }
                  />
                </View>
                <View style={s.row}>
                  <NumberField
                    label="Crop width %"
                    value={(layer.cropW || 1) * 100}
                    min={5}
                    max={(1 - (layer.cropX || 0)) * 100}
                    step={5}
                    change={(cropW) => patch({ cropW: cropW / 100 })}
                  />
                  <NumberField
                    label="Crop height %"
                    value={(layer.cropH || 1) * 100}
                    min={5}
                    max={(1 - (layer.cropY || 0)) * 100}
                    step={5}
                    change={(cropH) => patch({ cropH: cropH / 100 })}
                  />
                </View>
                <Button
                  label="Reset crop"
                  secondary
                  onPress={() => patch({ cropX: 0, cropY: 0, cropW: 1, cropH: 1 })}
                />
              </>
            )}
            <View style={s.row}>
              <Button
                label="To front"
                secondary
                onPress={() =>
                  patch({
                    z:
                      Math.max(
                        ...project.slides
                          .flatMap((s) => [...s.texts, ...(s.overlays || [])])
                          .map((l) => l.z || 0),
                      ) + 1,
                  })
                }
              />
              <Button
                label="To back"
                secondary
                onPress={() =>
                  patch({
                    z:
                      Math.min(
                        ...project.slides
                          .flatMap((s) => [...s.texts, ...(s.overlays || [])])
                          .map((l) => l.z || 0),
                      ) - 1,
                  })
                }
              />
            </View>
            <View style={s.row}>
              <Button label="Duplicate" secondary icon="copy-outline" onPress={duplicate} />
              <Button label="Delete layer" secondary icon="trash-outline" onPress={remove} />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
