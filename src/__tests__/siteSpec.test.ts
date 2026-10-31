import { BLOCK_ORDER, parseSiteSpec } from '../document/siteSpec';

const site = (...blocks: unknown[]) => ({ version: 1, blocks });
const hero = { type: 'hero', props: { title: 'Receipt', kind: 'Receipt', issuer: 'Corner Cafe', date: '2026-09-30' } };
const table = (n: number) => ({ type: 'table', props: { columns: ['Item', 'Qty'], rows: [[`row ${n}`, '1']] } });

describe('parseSiteSpec', () => {
  test('a spec that is not an object with blocks is one spec-level invalid report', () => {
    for (const bad of [null, 'x', [], { version: 1 }, { version: 1, blocks: {} }]) {
      expect(parseSiteSpec(bad)).toEqual({ blocks: [], unknown: [{ type: '', index: -1, reason: 'invalid', block: bad }] });
    }
  });

  test('another version draws nothing and reports every block as unsupported', () => {
    const r = parseSiteSpec({ version: 2, blocks: [hero, { nope: 1 }] });
    expect(r.blocks).toEqual([]);
    expect(r.unknown).toEqual([
      { type: 'hero', index: 0, reason: 'unsupported_version', block: hero },
      { type: '', index: 1, reason: 'unsupported_version', block: { nope: 1 } },
    ]);
  });

  test('blocks come back in layout order; unknown types are reported with their index', () => {
    const source = { type: 'source', props: { note: 'Built from the text.', pages: 2 } };
    const summary = { type: 'summary', props: { text: 'A receipt.', source: { page: 1 } } };
    const highlights = { type: 'highlights', props: {} };
    const r = parseSiteSpec(site(source, highlights, summary, hero));
    expect(r.blocks.map((b) => b.type)).toEqual(['hero', 'summary', 'source']);
    expect(r.unknown).toEqual([{ type: 'highlights', index: 1, reason: 'unknown', block: highlights }]);
    expect(BLOCK_ORDER[0]).toBe('hero');
  });

  test('a known type with unusable props is invalid, and so is a second copy of a single-use block', () => {
    const r = parseSiteSpec(site(hero, { type: 'hero', props: { title: 'Again', kind: 'X' } }, { type: 'summary', props: { text: '  ' } }, { type: 'key_facts' }));
    expect(r.blocks).toHaveLength(1);
    expect(r.unknown.map((u) => [u.index, u.type, u.reason])).toEqual([
      [1, 'hero', 'invalid'],
      [2, 'summary', 'invalid'],
      [3, 'key_facts', 'invalid'],
    ]);
  });

  test('keeps only the usable items, sources and lines', () => {
    const r = parseSiteSpec(
      site(
        { type: 'key_facts', props: { items: [{ label: 'Nr', value: 'A-1', source: { page: 1, line: 0 } }, { label: '', value: 'x' }, 'junk'] } },
        { type: 'amount', props: { label: 'Total', value: '12.40', currency: 'EUR', totals: [{ label: 'VAT', value: '1.98' }, { label: 'bad' }] } },
        { type: 'parties', props: { from: { name: 'Corner Cafe', lines: ['Main St 1', '', 3] }, to: { name: ' ' } } },
        { type: 'timeline', props: { items: [{ date: '2026-09-30', label: 'Paid' }, { date: '', label: 'x' }] } },
      ),
    );
    expect(r.unknown).toEqual([]);
    expect(r.blocks).toEqual([
      { type: 'key_facts', props: { items: [{ label: 'Nr', value: 'A-1', source: { page: 1 } }] } },
      { type: 'amount', props: { label: 'Total', value: '12.40', currency: 'EUR', totals: [{ label: 'VAT', value: '1.98' }] } },
      { type: 'parties', props: { from: { name: 'Corner Cafe', lines: ['Main St 1'] } } },
      { type: 'timeline', props: { items: [{ date: '2026-09-30', label: 'Paid' }] } },
    ]);
  });

  test('table rows are padded or cut to the columns; a table needs string columns and a row', () => {
    const r = parseSiteSpec(site({ type: 'table', props: { columns: ['A', 'B'], rows: [['1'], ['1', '2', '3'], 'junk', [4, '5']] } }));
    expect(r.blocks).toEqual([{ type: 'table', props: { columns: ['A', 'B'], rows: [['1', ''], ['1', '2'], ['', '5']] } }]);
    expect(parseSiteSpec(site({ type: 'table', props: { columns: ['A', 2], rows: [['1']] } })).unknown[0]!.reason).toBe('invalid');
    expect(parseSiteSpec(site({ type: 'table', props: { columns: ['A'], rows: [] } })).unknown[0]!.reason).toBe('invalid');
  });

  test('up to three tables, in their order; a fourth is invalid', () => {
    const r = parseSiteSpec(site(table(1), hero, table(2), table(3), table(4)));
    expect(r.blocks.map((b) => (b.type === 'table' ? b.props.rows[0]![0] : b.type))).toEqual(['hero', 'row 1', 'row 2', 'row 3']);
    expect(r.unknown).toEqual([{ type: 'table', index: 4, reason: 'invalid', block: table(4) }]);
  });
});
