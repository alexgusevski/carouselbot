import React from 'react';
import { Pressable, Text, View, StyleSheet, ActivityIndicator, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors as c } from './theme';
export function Button({
  label,
  onPress,
  secondary = false,
  disabled = false,
  icon,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: secondary ? c.white : c.ink,
          opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
        },
      ]}
    >
      {icon && <Ionicons name={icon} size={19} color={secondary ? c.ink : c.white} />}
      <Text style={{ color: secondary ? c.ink : c.white, fontSize: 15, fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );
}
export function IconButton({
  name,
  label,
  onPress,
  disabled = false,
}: {
  name: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.3 : pressed ? 0.5 : 1,
      })}
    >
      <Ionicons name={name} size={23} color={c.ink} />
    </Pressable>
  );
}
export function Loading({ text = 'Opening your workspace…' }: { text?: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={c.accentInk} />
      <Text style={styles.muted}>{text}</Text>
    </View>
  );
}
export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <View style={{ padding: 20, gap: 14 }}>
      <Text style={{ color: c.danger, fontSize: 15 }}>{message}</Text>
      {retry && <Button label="Try again" secondary onPress={retry} />}
    </View>
  );
}
export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.paper },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  title: { fontSize: 30, fontWeight: '700', color: c.ink, letterSpacing: -1 },
  muted: { color: c.muted, fontSize: 14 },
  button: {
    minHeight: 48,
    borderRadius: 16,
    paddingHorizontal: 18,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  input: {
    backgroundColor: c.white,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 14,
    padding: 14,
    color: c.ink,
    fontSize: 16,
  },
});
