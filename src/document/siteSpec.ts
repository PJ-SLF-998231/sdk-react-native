/**
 * Reads a version-1 document-site spec (api/docs/document-site.schema.json) into typed blocks, tolerantly: the API
 * validates what it stores, so this does not re-run the schema. It only keeps a block it can draw, drops what it
 * cannot (an unknown type, or a known type whose props are unusable) and reports each dropped block, so a newer API
 * degrades to "the blocks this version knows" rather than to a blank screen. Everything in a spec is data: it is
 * drawn as text and never evaluated.
 */

export interface SourceRef {
  page?: number;
  line?: number;
}
export interface HeroProps { title: string; kind: string; issuer?: string; date?: string }
export interface SummaryProps { text: string; source?: SourceRef }
export interface KeyFactsProps { items: { label: string; value: string; source?: SourceRef }[] }
export interface AmountLine { label: string; value: string; currency?: string; source?: SourceRef }
export interface AmountProps extends AmountLine { totals?: AmountLine[] }
export interface Party { name: string; lines?: string[]; source?: SourceRef }
export interface PartiesProps { from?: Party; to?: Party }
export interface TimelineProps { items: { date: string; label: string; source?: SourceRef }[] }
export interface TableProps { columns: string[]; rows: string[][]; source?: SourceRef }
export interface SourceProps { pages?: number; note: string }

export type Block =
  | { type: 'hero'; props: HeroProps }
  | { type: 'summary'; props: SummaryProps }
  | { type: 'key_facts'; props: KeyFactsProps }
  | { type: 'amount'; props: AmountProps }
  | { type: 'parties'; props: PartiesProps }
  | { type: 'timeline'; props: TimelineProps }
  | { type: 'table'; props: TableProps }
  | { type: 'source'; props: SourceProps };

export type BlockType = Block['type'];
/** The fixed order the site lays blocks out in, whatever order the spec lists them. */
export const BLOCK_ORDER: readonly BlockType[] = ['hero', 'summary', 'key_facts', 'amount', 'parties', 'timeline', 'table', 'source'];

/** Tables a site may have (docs/document-site.schema.json: each type at most once except table, at most 3). */
const MAX_TABLES = 3;

/** A block this version could not draw. */
export interface UnknownBlockReport {
  /** The block's `type` as sent ('' when it has none). */
  type: string;
  /** Position in the spec's `blocks` array; -1 for a spec-level problem (unsupported version, no blocks array). */
  index: number;
  /** unknown: no such block type here. invalid: a known type with unusable props. unsupported_version: the spec's version is not 1. */
  reason: 'unknown' | 'invalid' | 'unsupported_version';
  block: unknown;
}

export interface ParsedSite {
  blocks: Block[];
  unknown: UnknownBlockReport[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const cell = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function ref(v: unknown): SourceRef | undefined {
  if (!isObj(v)) return undefined;
  const out: SourceRef = {};
  if (typeof v.page === 'number' && v.page >= 1) out.page = v.page;
  if (typeof v.line === 'number' && v.line >= 1) out.line = v.line;
  return out.page !== undefined || out.line !== undefined ? out : undefined;
}
const withSource = <T extends object>(o: T, v: unknown): T => {
  const s = ref(v);
  return s ? { ...o, source: s } : o;
};

function amountLine(v: unknown): AmountLine | undefined {
  if (!isObj(v)) return undefined;
  const label = str(v.label);
  const value = str(v.value);
  if (!label || !value) return undefined;
  const out: AmountLine = { label, value };
  if (typeof v.currency === 'string' && v.currency) out.currency = v.currency;
  return withSource(out, v.source);
}

function party(v: unknown): Party | undefined {
  if (!isObj(v)) return undefined;
  const name = str(v.name);
  if (!name) return undefined;
  const out: Party = { name };
  if (Array.isArray(v.lines)) out.lines = v.lines.map(str).filter((l): l is string => l !== undefined);
  return withSource(out, v.source);
}

function readBlock(type: string, p: Record<string, unknown>): Block | undefined {
  switch (type) {
    case 'hero': {
      const title = str(p.title);
      const kind = str(p.kind);
      if (!title || !kind) return undefined;
      const props: HeroProps = { title, kind };
      const issuer = str(p.issuer);
      const date = str(p.date);
      if (issuer) props.issuer = issuer;
      if (date) props.date = date;
      return { type, props };
    }
    case 'summary': {
      const text = str(p.text);
      return text ? { type, props: withSource({ text }, p.source) } : undefined;
    }
    case 'key_facts': {
      if (!Array.isArray(p.items)) return undefined;
      const items = p.items.flatMap((i) => {
        if (!isObj(i)) return [];
        const label = str(i.label);
        const value = str(i.value);
        return label && value ? [withSource({ label, value }, i.source)] : [];
      });
      return items.length ? { type, props: { items } } : undefined;
    }
    case 'amount': {
      const head = amountLine(p);
      if (!head) return undefined;
      const totals = Array.isArray(p.totals) ? p.totals.map(amountLine).filter((t): t is AmountLine => t !== undefined) : [];
      return { type, props: totals.length ? { ...head, totals } : head };
    }
    case 'parties': {
      const from = party(p.from);
      const to = party(p.to);
      if (!from && !to) return undefined;
      return { type, props: { ...(from ? { from } : {}), ...(to ? { to } : {}) } };
    }
    case 'timeline': {
      if (!Array.isArray(p.items)) return undefined;
      const items = p.items.flatMap((i) => {
        if (!isObj(i)) return [];
        const date = str(i.date);
        const label = str(i.label);
        return date && label ? [withSource({ date, label }, i.source)] : [];
      });
      return items.length ? { type, props: { items } } : undefined;
    }
    case 'table': {
      if (!Array.isArray(p.columns) || !Array.isArray(p.rows)) return undefined;
      const columns = p.columns.map(cell);
      if (columns.length === 0 || columns.some((c) => c === undefined)) return undefined;
      const rows = p.rows.flatMap((r) => {
        if (!Array.isArray(r)) return [];
        // One cell per column: short rows are padded, long rows cut, so a malformed row never misaligns the table.
        return [columns.map((_, i) => cell(r[i]) ?? '')];
      });
      return rows.length ? { type, props: withSource({ columns: columns as string[], rows }, p.source) } : undefined;
    }
    case 'source': {
      const note = str(p.note);
      if (!note) return undefined;
      const props: SourceProps = { note };
      if (typeof p.pages === 'number' && p.pages >= 1) props.pages = p.pages;
      return { type, props };
    }
    default:
      return undefined;
  }
}

/** Parses `spec` (any JSON), returning the drawable blocks in layout order and a report per block that was dropped. */
export function parseSiteSpec(spec: unknown): ParsedSite {
  if (!isObj(spec) || !Array.isArray(spec.blocks)) {
    return { blocks: [], unknown: [{ type: '', index: -1, reason: 'invalid', block: spec }] };
  }
  const raw = spec.blocks as unknown[];
  if (spec.version !== 1) {
    return { blocks: [], unknown: raw.map((b, index) => ({ type: isObj(b) && typeof b.type === 'string' ? b.type : '', index, reason: 'unsupported_version' as const, block: b })) };
  }
  const blocks: Block[] = [];
  const unknown: UnknownBlockReport[] = [];
  const seen = new Set<string>();
  let tables = 0;
  raw.forEach((b, index) => {
    const type = isObj(b) && typeof b.type === 'string' ? b.type : '';
    if (!(BLOCK_ORDER as readonly string[]).includes(type)) {
      unknown.push({ type, index, reason: 'unknown', block: b });
      return;
    }
    const read = isObj(b) && isObj(b.props) ? readBlock(type, b.props) : undefined;
    // Each type once, tables up to three (the schema's limit): a repeat past that is dropped like any other unusable block.
    const duplicate = type === 'table' ? tables >= MAX_TABLES : seen.has(type);
    if (!read || duplicate) {
      unknown.push({ type, index, reason: 'invalid', block: b });
      return;
    }
    seen.add(type);
    if (type === 'table') tables += 1;
    blocks.push(read);
  });
  blocks.sort((a, b) => BLOCK_ORDER.indexOf(a.type) - BLOCK_ORDER.indexOf(b.type));
  return { blocks, unknown };
}
