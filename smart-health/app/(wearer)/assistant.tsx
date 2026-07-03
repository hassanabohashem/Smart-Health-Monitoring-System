import { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, FlatList, KeyboardAvoidingView, Platform, ScrollView,
  SafeAreaView, Text, Pressable, ActivityIndicator,
} from 'react-native';
import { TextInput } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import Markdown from 'react-native-markdown-display';
import { useAuthStore } from '@/stores/auth.store';
import { useAssistantChatStore } from '@/stores/assistant-chat.store';
import { useVitalsStore } from '@/stores/vitals.store';
import { generateResponse, matchQuestionKey } from '@/services/chat.service';
import {
  isAssistantEnabled, askAssistant, SmartHealthApiError, type StreamFinal,
} from '@/services/assistant';
import type { ChatMessage, QuickReply } from '@/types/chat.types';
import {
  useDesignTokens, PageHeader, ChatBubble, Banner,
} from '@/design';
import { fontFamily, radius, spacing } from '@/design/tokens';
import { AuthIcon } from '@/components/AuthControls';

const MAX_HISTORY = 8;
const ENABLED = isAssistantEnabled();

export default function AssistantScreen() {
  const { palette } = useDesignTokens();
  const { t } = useTranslation();
  const profile = useAuthStore((s) => s.profile);
  // Chat thread + composer text + emergency banner live in a global
  // in-memory store so they survive tab switches and navigation. See
  // src/stores/assistant-chat.store.ts for the rationale (hybrid
  // persistence: in-memory only, resets on app cold start).
  const messages = useAssistantChatStore((s) => s.messages);
  const setMessages = useAssistantChatStore((s) => s.setMessages);
  const updateMessages = useAssistantChatStore((s) => s.updateMessages);
  const input = useAssistantChatStore((s) => s.input);
  const setInput = useAssistantChatStore((s) => s.setInput);
  const emergency = useAssistantChatStore((s) => s.emergency);
  const setEmergency = useAssistantChatStore((s) => s.setEmergency);
  // `sending` and the abort controller stay component-local — the
  // in-flight request is screen-scoped and cancels on unmount.
  const [sending, setSending] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Seed the welcome message once when the thread is empty (first
  // open ever, or after a sign-out/reset). Built fresh so the
  // greeting reflects the current user + time-of-day.
  useEffect(() => {
    if (messages.length > 0) return;
    const h = new Date().getHours();
    const slot = h < 12 ? 'morning' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'night';
    const partOfDay = t(`assistant.welcomePartOfDay_${slot}`);
    const name = profile?.full_name?.split(' ')[0] || t('assistant.welcomeFallbackName');
    // Reflect the wearer's live heart rate when there's a reading, so the
    // greeting opens from their actual data instead of a generic line.
    const hr = useVitalsStore.getState().heartRate;
    const welcomeText = hr != null
      ? t('assistant.welcomeWithHr', { partOfDay, name, hr })
      : t('assistant.welcome', { partOfDay, name });
    setMessages([
      { id: '0', role: 'assistant', text: welcomeText, timestamp: Date.now() },
    ]);
  }, [messages.length, profile?.full_name, t, setMessages]);

  const getHistory = useCallback(() => {
    return messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text }));
  }, [messages]);

  // Suggestion chips — text-only, matching the design source
  // (Today's summary / Steps yesterday / Sleep quality).
  const quickReplies: QuickReply[] = [
    { label: t('assistant.qrSummary'), key: 'summary',    icon: 'chart-box-outline' },
    { label: t('assistant.qrSteps'),   key: 'steps',      icon: 'shoe-print' },
    { label: t('assistant.qrSleep'),   key: 'sleep',      icon: 'sleep' },
  ];

  const sendCanned = useCallback((userMsg: ChatMessage, questionKey?: string) => {
    setTimeout(() => {
      const key = questionKey || matchQuestionKey(userMsg.text);
      const response = generateResponse(key);
      updateMessages((prev) => [...prev, {
        id: `${Date.now()}-a`, role: 'assistant', text: response, timestamp: Date.now(),
      }]);
    }, 400);
  }, [updateMessages]);

  const sendStreamed = useCallback(async (userMsg: ChatMessage) => {
    const assistantId = `${Date.now()}-a`;
    const history = getHistory();
    updateMessages((prev) => [...prev, {
      id: assistantId, role: 'assistant', text: '', timestamp: Date.now(),
    }]);
    setSending(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const result = await askAssistant(userMsg.text, { chat_history: history });
      if (ac.signal.aborted) return;
      updateMessages((prev) => prev.map((m) =>
        m.id === assistantId ? { ...m,
          text: result.answer ?? '',
          meta: {
            emergency: result.emergency ?? false,
            emergency_reason: result.emergency_reason ?? null,
            red_flag_categories: result.red_flags?.map((rf) => rf.category) ?? [],
            severity: result.severity ?? null,
            model: result.model,
            from_cache: result.from_cache ?? false,
            latency_ms: result.latency_ms ?? null,
            follow_ups: result.follow_ups ?? [],
            sources: result.sources ?? [],
          },
        } : m));
      if (result.emergency) setEmergency(result as unknown as StreamFinal);
    } catch (e) {
      console.error('[assistant] chat failed:', e);
      const errText = e instanceof SmartHealthApiError && e.status === 429
        ? t('assistant.rateLimited') || 'The AI is busy — please try again in a moment.'
        : e instanceof SmartHealthApiError
          ? `${e.message}${e.status ? ` (HTTP ${e.status})` : ''}`
          : t('assistant.unreachable') || "Couldn't reach the assistant. Check your connection.";
      updateMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, text: errText } : m));
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [getHistory, t, updateMessages, setEmergency]);

  const sendMessage = useCallback((text: string, questionKey?: string) => {
    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', text, timestamp: Date.now() };
    updateMessages((prev) => [...prev, userMsg]);
    setInput('');
    if (ENABLED) void sendStreamed(userMsg); else sendCanned(userMsg, questionKey);
  }, [sendCanned, sendStreamed, updateMessages, setInput]);

  const handleQuickReply = (qr: QuickReply) => { if (!sending) sendMessage(qr.label, qr.key); };

  const handleSend = () => { if (input.trim() && !sending) sendMessage(input.trim()); };

  // On unmount, cancel the in-flight request AND drop any empty
  // assistant bubble we left behind. Without this cleanup the user
  // could navigate away mid-stream and come back to a permanent
  // spinner (the bubble survives in the store, but the request that
  // would fill it is dead).
  useEffect(() => () => {
    abortRef.current?.abort();
    updateMessages((prev) => prev.filter((m) => m.role !== 'assistant' || m.text !== ''));
  }, [updateMessages]);

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    const isUser = item.role === 'user';
    const isEmpty = !item.text && !isUser;

    return (
      <View style={{
        flexDirection: 'row', marginBottom: 12, gap: 8,
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        alignItems: 'flex-end',
      }}>
        {!isUser && (
          // Lucide-style bot avatar matching the tab-bar icon set.
          // Replaces the previous MaterialCommunityIcons robot-outline
          // so the same glyph appears in the bubble row and the tab.
          <View style={{
            width: 32, height: 32, borderRadius: 999,
            backgroundColor: palette.accentSoft,
            alignItems: 'center', justifyContent: 'center',
          }}>
            <AuthIcon name="bot" color={palette.accentInk} size={18} />
          </View>
        )}
        <View style={{ flexShrink: 1, maxWidth: '85%' }}>
          <ChatBubble side={isUser ? 'user' : 'assistant'}>
            {isEmpty ? (
              <ActivityIndicator size="small" color={palette.text2} />
            ) : isUser ? (
              item.text
            ) : (
              <Markdown style={{
                body: { color: palette.text, fontSize: 13, fontFamily: fontFamily.sans },
                heading1: { color: palette.text, fontSize: 17, fontWeight: '700', fontFamily: fontFamily.sansSemibold, marginTop: 4, marginBottom: 4 },
                heading2: { color: palette.text, fontSize: 15, fontWeight: '600', fontFamily: fontFamily.sansSemibold, marginTop: 6, marginBottom: 4 },
                heading3: { color: palette.text, fontSize: 14, fontWeight: '600', fontFamily: fontFamily.sansSemibold, marginTop: 4, marginBottom: 2 },
                strong: { color: palette.text, fontWeight: '700' },
                em: { color: palette.text, fontStyle: 'italic' },
                bullet_list: { marginVertical: 4 },
                ordered_list: { marginVertical: 4 },
                list_item: { color: palette.text, marginVertical: 2 },
                hr: { backgroundColor: palette.divider, height: 1, marginVertical: 6 },
                code_inline: {
                  backgroundColor: palette.surface2, color: palette.text2,
                  paddingHorizontal: 4, borderRadius: 3, fontFamily: fontFamily.mono,
                },
                link: { color: palette.accentInk },
              }}>
                {item.text}
              </Markdown>
            )}
          </ChatBubble>

          {/* Sources line + thumbs-up/down feedback row removed — the
              bubble is cleaner without them and the chat reads as a
              conversation, not a citation-tracked clinical report.
              The `meta.sources` + `feedback` fields are still
              populated on the message object for future use (e.g.
              an analytics dump or an admin debug overlay). */}
        </View>
      </View>
    );
  };

  // Bottom chip row: latest assistant follow-ups when available,
  // otherwise the static defaults. Keeps only one chip strip on
  // screen at a time and avoids the inline robot-icon repeat.
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const liveFollowUps: string[] = sending
    ? []
    : (lastAssistant?.meta?.follow_ups ?? []);
  const bottomChips: { label: string; key: string; questionKey?: string }[] =
    liveFollowUps.length > 0
      ? liveFollowUps.map((q, i) => ({ label: q, key: `fu-${i}` }))
      : quickReplies.map((q) => ({ label: q.label, key: q.key, questionKey: q.key }));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <PageHeader
        eyebrow={t('assistant.eyebrow')}
        title={t('assistant.title')}
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}
      >
        {/* Emergency banner stays pinned at the top — critical, must
            remain visible regardless of scroll. Uses the design-system
            Banner (soft danger) for visual consistency with safe-zones
            and other danger banners across the app. */}
        {emergency && (
          <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 2 }}>
            <Banner
              variant="danger"
              icon="alert-octagon"
              right={
                <Pressable
                  onPress={() => setEmergency(null)}
                  hitSlop={6}
                  style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                >
                  <Text style={{
                    fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 12.5,
                    color: palette.dangerInk,
                  }}>
                    {t('assistant.dismiss') || 'Dismiss'}
                  </Text>
                </Pressable>
              }
            >
              <Text style={{
                fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 13,
                color: palette.dangerInk,
              }}>
                {t('assistant.emergencyBanner') || 'This looks like an emergency. A critical alert has been sent to your caregivers. Call emergency services if needed.'}
              </Text>
            </Banner>
          </View>
        )}

        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          contentContainerStyle={{ padding: 16, paddingBottom: 8 }}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          // Private-to-you banner lives inside the list as a header
          // so it scrolls away with the first messages instead of
          // permanently eating screen real estate at the top.
          ListHeaderComponent={
            <View style={{ paddingBottom: 12 }}>
              <Banner variant="accent" icon="shield-check">
                <View style={{ gap: 2 }}>
                  <Text style={{
                    fontFamily: fontFamily.sansSemibold, fontWeight: '600',
                    fontSize: 12.5, color: palette.accentInk,
                  }}>{t('assistant.privateTitle')}</Text>
                  <Text style={{ fontSize: 11, opacity: 0.85, color: palette.accentInk }}>
                    {t('assistant.privateSub')}
                  </Text>
                </View>
              </Banner>
            </View>
          }
        />

        {/* Suggestion chips — context-aware. When the latest
            assistant response surfaced follow-up questions, this row
            shows those instead of the static defaults (Today's
            summary / Steps yesterday / Sleep quality). */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          // Let the row size to its content — the previous maxHeight: 56
          // clipped the bottom edge of the chips by ~1-2 px due to
          // pixel rounding around shadows/borders.
          style={{ flexGrow: 0, flexShrink: 0 }}
        >
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}>
            {bottomChips.map((chip) => (
              <Pressable
                key={chip.key}
                onPress={() => {
                  if (sending) return;
                  sendMessage(chip.label, chip.questionKey);
                }}
                disabled={sending}
                style={{
                  height: 36, paddingHorizontal: 14, borderRadius: 999,
                  backgroundColor: palette.accentSoft,
                  opacity: sending ? 0.5 : 1,
                  alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Text style={{
                  color: palette.accentInk, fontSize: 13,
                  fontFamily: fontFamily.sansMedium, fontWeight: '500',
                }}>{chip.label}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        {/* Composer row: rounded input on the left + sage send circle on the right */}
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12,
          backgroundColor: palette.bg,
        }}>
          <View style={{
            flex: 1, height: 44,
            backgroundColor: palette.surface,
            borderRadius: radius.md,
            borderWidth: 1, borderColor: palette.border,
            paddingHorizontal: 16,
            justifyContent: 'center',
          }}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder={t('assistant.placeholder')}
              mode="flat"
              dense
              underlineStyle={{ display: 'none' }}
              style={{
                backgroundColor: 'transparent',
                paddingHorizontal: 0,
                fontFamily: fontFamily.sans,
                fontSize: 14,
              }}
              onSubmitEditing={handleSend}
              returnKeyType="send"
              editable={!sending}
            />
          </View>
          <Pressable
            onPress={sending ? () => abortRef.current?.abort() : handleSend}
            disabled={!sending && !input.trim()}
            style={({ pressed }) => ({
              width: 44, height: 44, borderRadius: 999,
              backgroundColor: palette.accent2,
              alignItems: 'center', justifyContent: 'center',
              opacity: (!sending && !input.trim()) || pressed ? 0.6 : 1,
            })}
          >
            <MaterialCommunityIcons
              name={sending ? 'stop' : 'send'}
              size={20}
              color={palette.textOnAccent}
            />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
