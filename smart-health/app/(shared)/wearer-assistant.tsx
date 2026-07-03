import { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, FlatList, KeyboardAvoidingView, Platform, ScrollView,
  SafeAreaView, Text, Pressable, ActivityIndicator,
} from 'react-native';
import { TextInput } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import Markdown from 'react-native-markdown-display';
import { supabase } from '@/services/supabase';
import { getLatestVitals } from '@/services/vitals.service';
import { getAlerts } from '@/services/alert.service';
import type { Alert as WearerAlert } from '@/types/alert.types';
import type { BiologicalSex } from '@/types/user.types';
import { useAssistantChatStore } from '@/stores/assistant-chat.store';
import {
  askAssistant, buildWearerOverrides, SmartHealthApiError,
  type StreamFinal, type ChatInput,
} from '@/services/assistant';
import type { ChatMessage } from '@/types/chat.types';
import { useDesignTokens, ChatBubble, Banner } from '@/design';
import { fontFamily, radius } from '@/design/tokens';
import { AuthIcon } from '@/components/AuthControls';

const MAX_HISTORY = 8;

/**
 * Caregiver-side assistant, scoped to ONE wearer. Same chat UI + backend
 * as the wearer's own assistant, but the patient / vitals / recent-events
 * context is built from the wearer being viewed (via `buildWearerOverrides`)
 * so the caregiver can ask about that wearer. Opened from Wearer Detail.
 */
export default function WearerAssistantScreen() {
  const { palette } = useDesignTokens();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();
  const hasName = !!(name && String(name).trim());
  const firstName = (name || '').split(' ')[0] || t('wearerDetail.unknown');

  // Shared in-memory chat store (the caregiver has no wearer-assistant
  // tab, so it's free to use here; reset on open for a fresh consult).
  const messages = useAssistantChatStore((s) => s.messages);
  const setMessages = useAssistantChatStore((s) => s.setMessages);
  const updateMessages = useAssistantChatStore((s) => s.updateMessages);
  const input = useAssistantChatStore((s) => s.input);
  const setInput = useAssistantChatStore((s) => s.setInput);
  const emergency = useAssistantChatStore((s) => s.emergency);
  const setEmergency = useAssistantChatStore((s) => s.setEmergency);
  const reset = useAssistantChatStore((s) => s.reset);

  const [sending, setSending] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Wearer context overrides (patient/vitals/recent-events). Populated
  // async on mount; defaults to caregiver role so role framing is right
  // even before the fetch lands.
  const ctxRef = useRef<Partial<ChatInput>>({ user_role: 'caregiver' });
  // The backend has no name field and can guess the wrong gender. Keep the
  // wearer's biological sex so we can pin the right pronoun in the framing.
  const sexRef = useRef<BiologicalSex | null>(null);

  // Fresh consultation each open: reset the store + seed a wearer-scoped
  // welcome. Re-runs if the caregiver opens it for a different wearer.
  useEffect(() => {
    reset();
    setMessages([{
      id: '0', role: 'assistant',
      text: t('wearerAssistant.welcome', { name: firstName }),
      timestamp: Date.now(),
    }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Build the wearer's context so the assistant answers about THIS wearer.
  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        const [profRes, latest, alerts] = await Promise.all([
          supabase.from('profiles').select('age, sex, conditions, medications').eq('id', id).single(),
          getLatestVitals(id),
          getAlerts(id, 20),
        ]);
        if (!alive) return;
        const prof = (profRes.data as { age: number | null; sex: BiologicalSex | null; conditions: string[]; medications: string[] } | null) ?? null;
        sexRef.current = prof?.sex ?? null;
        ctxRef.current = buildWearerOverrides({
          patientProfile: prof,
          latestVitals: latest,
          recentAlerts: (alerts as WearerAlert[]) ?? [],
        });
      } catch (e) {
        console.warn('[wearer-assistant] context fetch failed', e);
      }
    })();
    return () => { alive = false; };
  }, [id]);

  const getHistory = useCallback(() => messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text })), [messages]);

  const send = useCallback(async (userMsg: ChatMessage) => {
    const assistantId = `${Date.now()}-a`;
    const history = getHistory();
    updateMessages((prev) => [...prev, { id: assistantId, role: 'assistant', text: '', timestamp: Date.now() }]);
    setSending(true);
    const ac = new AbortController();
    abortRef.current = ac;
    // The deployed backend has no patient-name field and frames replies in
    // second person ("your heart rate…"), and can guess the wrong gender.
    // Since the caregiver is asking ABOUT the wearer, frame the question with
    // the wearer's name + biological-sex pronoun so the answer comes back in
    // the third person with the right gender. The displayed bubble keeps the
    // user's original text — only the API question is augmented.
    const pron = sexRef.current === 'M' ? 'he/him' : sexRef.current === 'F' ? 'she/her' : 'they/them';
    const apiQuestion = hasName
      ? `${userMsg.text}\n\n(Asked by ${firstName}'s caregiver about ${firstName} — answer about ${firstName} in the third person using ${pron} pronouns, never "you".)`
      : userMsg.text;
    try {
      const result = await askAssistant(apiQuestion, { ...ctxRef.current, chat_history: history });
      if (ac.signal.aborted) return;
      updateMessages((prev) => prev.map((m) => m.id === assistantId ? {
        ...m,
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
      const errText = e instanceof SmartHealthApiError && e.status === 429
        ? t('assistant.rateLimited')
        : e instanceof SmartHealthApiError
          ? `${e.message}${e.status ? ` (HTTP ${e.status})` : ''}`
          : t('assistant.unreachable');
      updateMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, text: errText } : m));
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [getHistory, t, updateMessages, setEmergency, hasName, firstName]);

  const sendMessage = useCallback((text: string) => {
    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', text, timestamp: Date.now() };
    updateMessages((prev) => [...prev, userMsg]);
    setInput('');
    void send(userMsg);
  }, [send, updateMessages, setInput]);

  const handleSend = () => { if (input.trim() && !sending) sendMessage(input.trim()); };

  // On unmount, cancel the in-flight request + drop any empty bubble.
  useEffect(() => () => {
    abortRef.current?.abort();
    updateMessages((prev) => prev.filter((m) => m.role !== 'assistant' || m.text !== ''));
  }, [updateMessages]);

  const suggestions = [
    t('wearerAssistant.qrSummary'),
    t('wearerAssistant.qrConcern'),
    t('wearerAssistant.qrAlert'),
  ];
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const liveFollowUps: string[] = sending ? [] : (lastAssistant?.meta?.follow_ups ?? []);
  const chips = liveFollowUps.length > 0 ? liveFollowUps : suggestions;

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    const isUser = item.role === 'user';
    const isEmpty = !item.text && !isUser;
    return (
      <View style={{ flexDirection: 'row', marginBottom: 12, gap: 8, justifyContent: isUser ? 'flex-end' : 'flex-start', alignItems: 'flex-end' }}>
        {!isUser && (
          <View style={{ width: 32, height: 32, borderRadius: 999, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
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
                heading2: { color: palette.text, fontSize: 15, fontWeight: '600', fontFamily: fontFamily.sansSemibold, marginTop: 6, marginBottom: 4 },
                strong: { color: palette.text, fontWeight: '700' },
                em: { color: palette.text, fontStyle: 'italic' },
                bullet_list: { marginVertical: 4 },
                list_item: { color: palette.text, marginVertical: 2 },
                link: { color: palette.accentInk },
              }}>
                {item.text}
              </Markdown>
            )}
          </ChatBubble>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      {/* Header — back + ASSISTANT eyebrow + wearer first name. */}
      <View style={{
        paddingTop: insets.top + 18, paddingHorizontal: 20, paddingBottom: 12,
        flexDirection: 'row', alignItems: 'center', gap: 14,
      }}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={6}
          style={({ pressed }) => ({
            width: 44, height: 44, borderRadius: 999, backgroundColor: palette.surface,
            borderWidth: 1, borderColor: palette.border, alignItems: 'center', justifyContent: 'center',
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <AuthIcon name="chevron-left" color={palette.text} size={22} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={{
            fontFamily: fontFamily.mono, fontSize: 10, letterSpacing: 1.2,
            textTransform: 'uppercase', fontWeight: '500', color: palette.text3,
          }}>{t('wearerAssistant.eyebrow')}</Text>
          <Text style={{
            fontFamily: fontFamily.sansSemibold, fontSize: 22, fontWeight: '600',
            letterSpacing: -0.44, color: palette.text,
          }} numberOfLines={1}>{firstName}</Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + 8}
      >
        {emergency && (
          <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 2 }}>
            <Banner
              variant="danger"
              icon="alert-octagon"
              right={
                <Pressable onPress={() => setEmergency(null)} hitSlop={6} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
                  <Text style={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 12.5, color: palette.dangerInk }}>
                    {t('assistant.dismiss')}
                  </Text>
                </Pressable>
              }
            >
              <Text style={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 13, color: palette.dangerInk }}>
                {t('wearerAssistant.emergencyBanner')}
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
          ListHeaderComponent={
            <View style={{ paddingBottom: 12 }}>
              <Banner variant="accent" icon="shield-check">
                <Text style={{ fontSize: 12, color: palette.accentInk }}>
                  {t('wearerAssistant.contextNote', { name: firstName })}
                </Text>
              </Banner>
            </View>
          }
        />

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 0 }}>
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}>
            {chips.map((label, i) => (
              <Pressable
                key={i}
                onPress={() => { if (!sending) sendMessage(label); }}
                disabled={sending}
                style={{ height: 36, paddingHorizontal: 14, borderRadius: 999, backgroundColor: palette.accentSoft, opacity: sending ? 0.5 : 1, alignItems: 'center', justifyContent: 'center' }}
              >
                <Text style={{ color: palette.accentInk, fontSize: 13, fontFamily: fontFamily.sansMedium, fontWeight: '500' }}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          paddingHorizontal: 16, paddingTop: 4, paddingBottom: insets.bottom + 14, backgroundColor: palette.bg,
        }}>
          <View style={{
            flex: 1, height: 44, backgroundColor: palette.surface, borderRadius: radius.md,
            borderWidth: 1, borderColor: palette.border, paddingHorizontal: 16, justifyContent: 'center',
          }}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder={t('wearerAssistant.placeholder', { name: firstName })}
              mode="flat"
              dense
              underlineStyle={{ display: 'none' }}
              style={{ backgroundColor: 'transparent', paddingHorizontal: 0, fontFamily: fontFamily.sans, fontSize: 14 }}
              onSubmitEditing={handleSend}
              returnKeyType="send"
              editable={!sending}
            />
          </View>
          <Pressable
            onPress={sending ? () => abortRef.current?.abort() : handleSend}
            disabled={!sending && !input.trim()}
            style={({ pressed }) => ({
              width: 44, height: 44, borderRadius: 999, backgroundColor: palette.accent2,
              alignItems: 'center', justifyContent: 'center',
              opacity: (!sending && !input.trim()) || pressed ? 0.6 : 1,
            })}
          >
            <MaterialCommunityIcons name={sending ? 'stop' : 'send'} size={20} color={palette.textOnAccent} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
