import type { ChatSession } from "./types.js";

/**
 * Transcript of a session.
 *
 * Every piece of output produced by a session (answers, thinking, tool calls)
 * is stored as a block. Blocks are grouped into pages so the whole session
 * fits in ONE Telegram message that is edited in place, with ◀/▶ navigation.
 * This keeps the number of messages per session at its minimum while keeping
 * every piece of output reachable.
 */

export type TranscriptKind = "answer" | "thinking" | "tools";

export type TranscriptBlock = {
  kind: TranscriptKind;
  html: string;
  text: string;
  at: number;
};

export type TranscriptPage = {
  index: number;
  total: number;
  blocks: TranscriptBlock[];
  html: string;
  text: string;
};

/** Maximum number of blocks kept in memory per session. */
export const TRANSCRIPT_MAX_BLOCKS = 400;
/** Maximum size of a single block (raw characters). */
export const TRANSCRIPT_BLOCK_BUDGET = 1800;
/**
 * Maximum size of one rendered page (HTML characters). Fixed so the pagination
 * does not reshuffle while the live section changes size.
 */
export const TRANSCRIPT_PAGE_BUDGET = 2200;

export function transcriptBlocks(s: ChatSession): TranscriptBlock[] {
  if (!s.transcript) s.transcript = [];
  return s.transcript;
}

export function appendTranscript(
  s: ChatSession,
  block: { kind: TranscriptKind; html: string; text: string; at?: number },
): TranscriptBlock {
  const list = transcriptBlocks(s);
  const entry: TranscriptBlock = { ...block, at: block.at ?? Date.now() };
  list.push(entry);
  if (list.length > TRANSCRIPT_MAX_BLOCKS) list.splice(0, list.length - TRANSCRIPT_MAX_BLOCKS);
  return entry;
}

/** Split raw text into chunks that fit the per-block budget, on line breaks. */
export function splitText(text: string, budget = TRANSCRIPT_BLOCK_BUDGET): string[] {
  const source = text.replace(/\r\n/g, "\n");
  if (!source.trim()) return [];
  const chunks: string[] = [];
  let rest = source;
  while (rest.length > budget) {
    let cut = rest.lastIndexOf("\n", budget);
    if (cut < budget * 0.4) cut = rest.lastIndexOf(" ", budget);
    if (cut <= 0) cut = budget;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim()) chunks.push(rest.trimEnd());
  return chunks;
}

/** Group blocks into pages that respect the page budget. */
export function paginateTranscript(
  blocks: TranscriptBlock[],
  budget = TRANSCRIPT_PAGE_BUDGET,
): TranscriptPage[] {
  const pages: TranscriptPage[] = [];
  let current: TranscriptBlock[] = [];
  let size = 0;
  const flush = () => {
    if (!current.length) return;
    pages.push({
      index: pages.length,
      total: 0,
      blocks: current,
      html: current.map((b) => b.html).join("\n\n"),
      text: current.map((b) => b.text).join("\n\n"),
    });
    current = [];
    size = 0;
  };
  for (const block of blocks) {
    const len = block.html.length + 2;
    if (current.length && size + len > budget) flush();
    current.push(block);
    size += len;
  }
  flush();
  return pages.map((p, i) => ({ ...p, index: i, total: pages.length }));
}

/**
 * Resolve which page should be displayed.
 * `follow` means the user never navigated away: new content keeps them on the
 * latest page. Otherwise their page is preserved and a "Latest" button shows up.
 */
export function resolvePage(
  pages: TranscriptPage[],
  current: number | undefined,
  follow: boolean,
): TranscriptPage | undefined {
  if (!pages.length) return undefined;
  const last = pages.length - 1;
  if (follow || current === undefined) return pages[last];
  const idx = Math.min(Math.max(0, current), last);
  return pages[idx];
}
