import type { TranscriptBlock } from "./transcript.js";
import type { TurnActivity } from "./activity.js";

/** How the session card is currently rendered (compact/reading/normal). */
export type CardView = {
  compact: boolean;
  reading: boolean;
  showResources: boolean;
  unified: boolean;
};

export type ChatSession = {
  sessionId: string;
  directory?: string;
  model?: { id: string; providerID: string; variant?: string };
  buffer: string;
  reasoningBuffer: string;
  toolCalls: string[];
  toolCallDetails: Array<{ id: string; name: string; input?: string; output?: string; status?: string }>;
  typingTimer?: ReturnType<typeof setInterval>;
  /** Coalesces streaming text deltas into one card update. */
  deltaFlushTimer?: ReturnType<typeof setTimeout>;
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
  /** P1.5: Unicode sparkline history of GPU utilisation. */
  gpuHistory?: number[];
  /** Accumulated session cost reported by OpenCode, when available. */
  cost?: number;
  cardTheme?: "auto" | "light" | "dark";
  /** Parent session id when this session is a fork/subagent. */
  parentId?: string;
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
  /** Timestamp of the last finished turn, used for the stable turn receipt. */
  turnFinishedAt?: number;
  /** Last turn-level failure (provider error, rate limit, interruption). */
  lastTurnError?: string;
  lastOutputTokens?: number;
  /** Accumulated output tokens across all steps of the current turn. */
  turnOutputTokens?: number;
  /** Compact per-turn activity counters and detail entries for the card. */
  activity?: TurnActivity;
  /** Whether the activity detail is currently shown inline on the card. */
  activityExpanded?: boolean;
  /** Timestamp of the first streamed token of the current turn (ms). */
  turnFirstStreamedAt?: number;
  lastContextTokens?: number;
  contextWindow?: number;
  /** Full transcript of the session, rendered as paginated pages. */
  transcript?: TranscriptBlock[];
  /** Telegram message that hosts the paginated transcript. */
  transcriptMessageId?: number;
  /** Reusable drill-down message for diffs/files opened from the card. */
  detailMessageId?: number;
  /** Hide the CPU/RAM/VRAM block on the card (toggled from its keyboard). */
  resourcesCollapsed?: boolean;
  /** Page currently displayed in the transcript message. */
  transcriptPage?: number;
  /** True while the user has not navigated away from the latest page. */
  transcriptFollow?: boolean;
  /** Last turn shown in the card; used for the two-line "antes…" recap. */
  lastViewedTurn?: number;
  /** Full keyboard shown after the user taps ▾ Más on a compact card. */
  cardMenuExpanded?: boolean;
  /** Reading mode shows only the paginated transcript on the same message. */
  readingMode?: boolean;
  /** Last view configuration published by status.publishCard. */
  cardView?: CardView;
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
