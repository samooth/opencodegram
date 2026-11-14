import type { TranscriptBlock } from "./transcript.js";

export type ChatSession = {
  sessionId: string;
  directory?: string;
  model?: { id: string; providerID: string; variant?: string };
  draftId: number;
  buffer: string;
  reasoningBuffer: string;
  toolCalls: string[];
  toolCallDetails: Array<{ id: string; name: string; input?: string; output?: string; status?: string }>;
  timer?: ReturnType<typeof setTimeout>;
  typingTimer?: ReturnType<typeof setInterval>;
  statusTimer?: ReturnType<typeof setInterval>;
  stopped: boolean;
  /**
   * True when the session lost its route binding but is still alive.
   * Detached sessions keep working and must still deliver their final answer
   * to the chat/topic they were started in.
   */
  detached?: boolean;
  threadId?: number;
  cotBuffer?: string;
  cotCount?: number;
  expandedEditIndex?: number;
  compacting?: boolean;
  compactionSummary?: string;
  compactionError?: string;
  cpuHistory?: number[];
  memHistory?: number[];
  targetChatId?: number;
  targetThreadId?: number;
  topicTitle?: string;
  userMessageId?: number;
  lastTyping?: number;
  statusMessageId?: number;
  statusLastUpdate?: number;
  statusLastText?: string;
  statusEditing?: boolean;
  lastFinalMessageId?: string; // OpenCode assistant message ID (duplicate suppression)
  lastFinalTelegramMessageId?: number; // Telegram message ID (coalescing rapid finals)
  lastFinalSentAt?: number;
  textEndedHandled?: boolean;
  sentArtifacts?: Set<string>;
  statusPendingUpdate?: boolean;
  statusFinished?: boolean;
  statusEditPromise?: Promise<unknown>;
  promptStartTime?: number;
  lastOutputTokens?: number;
  lastContextTokens?: number;
  contextWindow?: number;
  /** Full transcript of the session, rendered as paginated pages. */
  transcript?: TranscriptBlock[];
  /** Telegram message that hosts the paginated transcript. */
  transcriptMessageId?: number;
  /** Page currently displayed in the transcript message. */
  transcriptPage?: number;
  /** True while the user has not navigated away from the latest page. */
  transcriptFollow?: boolean;
  /** Increments on every turn start; transcript blocks are tagged with it. */
  turnSeq?: number;
  /** Cumulative tool-call counters for the session (dashboard/stats). */
  toolStats?: { total: number; success: number; failed: number };
  /** Last final answer text, kept for "view full" actions. */
  lastFinalText?: string;
  /** promptStartTime of the turn whose final answer was already delivered (dedup). */
  lastFinalDeliveredPromptStart?: number;
  /** promptStartTime of the turn whose long answer was already sent separately (dedup). */
  lastFinalSeparatedPromptStart?: number;
  /** Throttle timestamp for dashboard (M1) updates. */
  dashboardLastUpdate?: number;
};
