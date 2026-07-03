export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: number;
  /** Set for assistant messages when we got a structured response from the backend. */
  meta?: {
    emergency?: boolean;
    emergency_reason?: string | null;
    red_flag_categories?: string[];
    severity?: string | null;
    model?: string;
    from_cache?: boolean;
    latency_ms?: number | null;
    /** Suggested follow-up questions the user can tap. */
    follow_ups?: string[];
    /** Corpus chunks the answer was grounded in. */
    sources?: { source: string; chunk?: number; snippet?: string }[];
  };
  /** True while this assistant bubble is still loading (thinking state). */
  loading?: boolean;
  /** True if the request failed and this is an error bubble. */
  error?: boolean;
  /** User's rating on this bubble. 0 = not rated, 1 = helpful, -1 = not helpful. */
  feedback?: 0 | 1 | -1;
}

export interface QuickReply {
  label: string;
  key: string;
  icon: string;
}
