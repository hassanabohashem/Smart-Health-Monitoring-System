/**
 * Hybrid chat persistence for the Assistant tab.
 *
 * In-memory only — no AsyncStorage. Survives tab switches and
 * navigation (because it's lifted out of the screen component's
 * local state), but resets on app cold start. Matches a clinical
 * "each session is its own consultation" convention without the
 * friction of losing context every time the user tabs away to
 * check vitals.
 *
 * Privacy posture: nothing about the conversation is ever written
 * to disk. If the device is compromised, no past chat is recoverable
 * from local storage.
 *
 * Owns:
 *   - messages: the chat thread
 *   - input:    the composer text (also survives tab switches)
 *   - emergency: the red-banner state when the assistant flagged a
 *                life-threatening reply
 *
 * Does NOT own:
 *   - sending: in-flight request state stays component-local, since
 *     the request itself is component-scoped via AbortController.
 *   - the welcome message: the screen adds it on mount when messages
 *     is empty (so the greeting reflects current profile + time-of-day).
 */

import { create } from 'zustand';
import type { ChatMessage } from '@/types/chat.types';
import type { StreamFinal } from '@/services/assistant';

interface AssistantChatState {
  messages: ChatMessage[];
  input: string;
  emergency: StreamFinal | null;

  /** Replace the whole thread (e.g. on welcome-message seed). */
  setMessages: (messages: ChatMessage[]) => void;
  /** Functional-style update for append / map operations. */
  updateMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  setInput: (input: string) => void;
  setEmergency: (e: StreamFinal | null) => void;
  /** Drop everything — used on sign-out and any future "New chat" CTA. */
  reset: () => void;
}

export const useAssistantChatStore = create<AssistantChatState>((set) => ({
  messages: [],
  input: '',
  emergency: null,

  setMessages: (messages) => set({ messages }),
  updateMessages: (updater) => set((state) => ({ messages: updater(state.messages) })),
  setInput: (input) => set({ input }),
  setEmergency: (emergency) => set({ emergency }),
  reset: () => set({ messages: [], input: '', emergency: null }),
}));
