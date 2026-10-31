import { chunkText, DEFAULT_CHUNK_CHARS } from '../document/textChunks';

describe('chunkText', () => {
  test('empty text has no chunks; short text is one chunk on page 1', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('Hello\nworld')).toEqual([{ key: '0-0', text: 'Hello\nworld', page: 1, pageStart: true }]);
  });

  test('form feeds start a new page; an empty page has no chunk but keeps the numbering', () => {
    const chunks = chunkText('one\ftwo\f\ffour');
    expect(chunks.map((c) => [c.key, c.text, c.page, c.pageStart])).toEqual([
      ['0-0', 'one', 1, true],
      ['1-0', 'two', 2, true],
      ['3-0', 'four', 4, true],
    ]);
  });

  test('a long page splits at the last line break, without a blank line at the start of the next chunk', () => {
    const chunks = chunkText('aaaa\nbbbb\ncccc', 10);
    expect(chunks.map((c) => c.text)).toEqual(['aaaa\nbbbb', 'cccc']);
    expect(chunks.map((c) => [c.key, c.pageStart])).toEqual([['0-0', true], ['0-1', false]]);
  });

  test('one enormous line splits at spaces, and with none at the hard limit', () => {
    expect(chunkText('alpha beta gamma delta', 11).map((c) => c.text)).toEqual(['alpha beta', 'gamma delta']);
    expect(chunkText('x'.repeat(25), 10).map((c) => c.text)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  test('no chunk exceeds the limit and no text is lost but the separators split on', () => {
    const words = Array.from({ length: 4000 }, (_, i) => (i % 13 === 0 ? `w${i}\n` : `w${i} `)).join('');
    const page = words.trimEnd();
    const chunks = chunkText(`${page}\f${page}`);
    expect(chunks.every((c) => c.text.length <= DEFAULT_CHUNK_CHARS)).toBe(true);
    expect(new Set(chunks.map((c) => c.key)).size).toBe(chunks.length);
    expect(chunks.filter((c) => c.pageStart).map((c) => c.page)).toEqual([1, 2]);
    const strip = (s: string) => s.replace(/\s+/g, '');
    expect(strip(chunks.filter((c) => c.page === 1).map((c) => c.text).join(''))).toBe(strip(page));
  });
});
