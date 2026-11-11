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

export type TranscriptKind = "answer" | "thinking" | "tools" | "meta";

export type TranscriptBlock = {
  kind: TranscriptKind;
  html: string;
  text: string;
  at: number;
  /** Turn sequence the block belongs to (see ChatSession.turnSeq). */
  turn?: number;
  /** Forces this block to start a new page (first block of a turn). */
  pageBreak?: boolean;
};

export type TranscriptPage = {
  index: number;
  total: number;
  blocks: TranscriptBlock[];
  html: string;
  text: string;
};

/**
 * Maximum number of blocks kept per session. Older blocks are dropped, so the
 * card keeps a navigable size instead of growing without limit.
 */
export const TRANSCRIPT_MAX_BLOCKS = 150;
/**
 * Only the most recent thinking/tools blocks are kept. The answers are the
 * valuable part of the history; the reasoning and the tool log are only
 * useful for the last turns.
 */
export const TRANSCRIPT_MAX_THINKING_BLOCKS = 6;
export const TRANSCRIPT_MAX_TOOLS_BLOCKS = 10;
/** Maximum size of a single block (raw characters). */
export const TRANSCRIPT_BLOCK_BUDGET = 1200;
/**
 * Maximum size of one rendered page (HTML characters). Fixed so the pagination
 * does not reshuffle while the live section changes size. It leaves room for
 * the header, the live strip, the page indicator and the resource indicators.
 */
export const TRANSCRIPT_PAGE_BUDGET = 2600;

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

/**
 * Split markdown so that every block of structure stays intact: paragraphs,
 * fenced code blocks and tables are never cut in half. Only a single oversized
 * paragraph is broken by lines.
 */
export function splitMarkdown(md: string, budget = TRANSCRIPT_BLOCK_BUDGET): string[] {
  const source = md.replace(/\r\n/g, "\n");
  if (!source.trim()) return [];
  if (source.length <= budget) return [source.trimEnd()];

  // Group into segments: a paragraph, a fenced code block or a table.
  const segments: string[] = [];
  const lines = source.split("\n");
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    if (!buf.length) return;
    const seg = buf.join("\n").trimEnd();
    if (seg) segments.push(seg);
    buf = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    buf.push(line);
    if (!inFence && !line.trim()) flush();
  }
  flush();

  const chunks: string[] = [];
  let current = "";
  for (const segment of segments) {
    if (segment.length > budget) {
      // Oversized segment: flush what we have and split it by lines.
      if (current) {
        chunks.push(current.trimEnd());
        current = "";
      }
      chunks.push(...splitText(segment, budget));
      continue;
    }
    if (!current) {
      current = segment;
      continue;
    }
    if (current.length + segment.length + 2 <= budget) {
      current += `\n\n${segment}`;
      continue;
    }
    chunks.push(current.trimEnd());
    current = segment;
  }
  if (current) chunks.push(current.trimEnd());
  return chunks.filter((c) => c.trim());
}

/**
 * Split markdown into parts that break at section boundaries first (headings
 * outside code fences), so a long answer becomes one message per section
 * instead of arbitrary size chunks. Returns [] when there are no usable
 * headings (caller falls back to splitMarkdown).
 */
export function splitBySections(md: string, budget = 3200): string[] {
  const source = md.replace(/\r\n/g, "\n");
  if (!source.trim()) return [];
  // Collect heading line indexes that are not inside a fenced code block.
  const lines = source.split("\n");
  const headingIdx: number[] = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    else if (!inFence && /^#{1,6}\s+\S/.test(line)) headingIdx.push(i);
  });
  if (headingIdx.length < 2) return [];
  // Section = heading line through the line before the next heading.
  const sections: string[] = [];
  // Any preamble before the first heading is its own section.
  if (headingIdx[0] > 0) {
    const preamble = lines.slice(0, headingIdx[0]).join("\n").trim();
    if (preamble) sections.push(preamble);
  }
  for (let i = 0; i < headingIdx.length; i++) {
    const start = headingIdx[i];
    const end = i + 1 < headingIdx.length ? headingIdx[i + 1] : lines.length;
    const section = lines.slice(start, end).join("\n").trimEnd();
    if (section) sections.push(section);
  }
  if (sections.length <= 1) return [];
  // Merge undersized neighbours; oversized sections fall back to splitMarkdown.
  const parts: string[] = [];
  let current = "";
  for (const section of sections) {
    if (section.length > budget) {
      if (current) {
        parts.push(current.trimEnd());
        current = "";
      }
      parts.push(...splitMarkdown(section, budget));
      continue;
    }
    if (!current) {
      current = section;
      continue;
    }
    if (current.length + section.length + 2 <= budget) {
      current += `\n\n${section}`;
      continue;
    }
    parts.push(current.trimEnd());
    current = section;
  }
  if (current) parts.push(current.trimEnd());
  // Only worth it when it actually differs from one giant chunk.
  return parts.length > 1 ? parts : [];
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
    // A turn's first block always starts a fresh page so the card shows the new
    // turn's content instead of re-showing the previous one.
    if (current.length && (size + len > budget || block.pageBreak)) flush();
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
