import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {createLunrIndex, searchDocuments} from '@/lib/search';
import {extractDocumentsFromMDX} from '@/lib/generateSearchIndex';
import type {SearchDocument} from '@/lib/search-types';

const getDocPath = (slug: string) =>
  path.join(process.cwd(), 'contents', 'docs', `${slug}.mdx`);

describe('search index', () => {
  it('creates section records for headings', async () => {
    const docs = await extractDocumentsFromMDX(getDocPath('zql'));
    const typeHelpersSection = docs.find(
      doc => doc.sectionId === 'type-helpers',
    );

    expect(typeHelpersSection?.sectionTitle).toBe('Type Helpers');
    expect(typeHelpersSection?.url).toBe('/docs/zql');
  });

  it('prioritizes section matches for multi-word queries', async () => {
    const docs = await extractDocumentsFromMDX(getDocPath('zql'));
    const index = createLunrIndex(docs);
    const results = searchDocuments({
      index,
      documents: docs,
      query: 'type helpers',
    });

    expect(results[0]?.composedUrl).toBe('/docs/zql#type-helpers');
  });

  it('handles punctuation-heavy queries', async () => {
    const docs = await extractDocumentsFromMDX(getDocPath('install'));
    const index = createLunrIndex(docs);
    const results = searchDocuments({
      index,
      documents: docs,
      query: 'postgres://',
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.composedUrl.startsWith('/docs/install')).toBe(true);
  });

  it('preserves dotted version numbers', () => {
    const docs: SearchDocument[] = [
      {
        id: 'release-1.8',
        title: 'Zero 1.8',
        searchTitle: 'Zero 1.8',
        content: 'Install Zero 1.8 for the latest improvements.',
        url: '/docs/release-notes/1.8',
        kind: 'page',
      },
      {
        id: 'zql',
        title: 'ZQL',
        searchTitle: 'ZQL',
        content: 'Call limit(100), subtract 1, and encode as UTF-8.',
        url: '/docs/zql',
        kind: 'page',
      },
    ];
    const index = createLunrIndex(docs);
    const results = searchDocuments({index, documents: docs, query: '1.8'});

    expect(results[0]?.url).toBe('/docs/release-notes/1.8');
    expect(results.some(result => result.id === 'zql')).toBe(false);
    expect(results[0]?.snippet).toContain('<mark>1.8</mark>');
    expect(results[0]?.snippet).not.toContain('<mark>1</mark>00');
  });
});
