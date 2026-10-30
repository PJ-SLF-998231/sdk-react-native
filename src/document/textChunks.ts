export interface TextChunk {
  key: string;
  text: string;
  /** 1-based page (form-feed separated) this chunk belongs to. */
  page: number;
  /** True for the first chunk of a page. */
  pageStart: boolean;
}

/** Characters per chunk: small enough that one native text node stays cheap, large enough that a long text is a few hundred rows at most. */
export const DEFAULT_CHUNK_CHARS = 3000;

/**
 * Splits text into chunks for a virtualised list: first on form feeds (the extractor's page breaks), then at line
 * breaks (or, for a single enormous line, at spaces or the hard limit) so no chunk exceeds `maxChars`. 
 */
export function chunkText(text: string, maxChars: number = DEFAULT_CHUNK_CHARS): TextChunk[] {
  const out: TextChunk[] = [];
  if (!text) return out;
  const pages = text.split('\f');
  pages.forEach((page, p) => {
    let start = 0;
    let n = 0;
    while (start < page.length) {
      let end = Math.min(start + maxChars, page.length);
      if (end < page.length) {
        const nl = page.lastIndexOf('\n', end);
        if (nl > start) end = nl;
        else {
          const sp = page.lastIndexOf(' ', end);
          if (sp > start) end = sp;
        }
      }
      const piece = page.slice(start, end);
      // Skip the separator we split on so chunks do not begin with a blank line.
      start = end < page.length && (page[end] === '\n' || page[end] === ' ') ? end + 1 : end;
      if (piece === '') continue;
      out.push({ key: `${p}-${n}`, text: piece, page: p + 1, pageStart: n === 0 });
      n += 1;
    }
  });
  return out;
}
