#!/usr/bin/env node
/**
 * Sitemap Scout
 * -------------
 * Read a site's sitemap.xml (including sitemap index files), normalize and
 * filter URLs, sample pages concurrently, and report which pages publish
 * JSON-LD structured data and which schema.org types they expose.
 *
 * Zero npm dependencies. Node.js >= 18. No API key, no browser.
 *
 * Usage:
 *   node scout.mjs [--sites sites.json] [--out .] [--concurrency 5]
 *
 * Exit code is always 0 so scheduled runs still publish a report; failures
 * are recorded inside results.json/results.md.
 */

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DEFAULT_SITEMAP_PATH = '/sitemap.xml';
const DEFAULT_MAX_PAGES = 20;
const MAX_SITEMAP_DEPTH = 2; // nested <sitemapindex> levels handled
const MAX_SITEMAP_URLS = 20000; // safety cap for very large sitemaps
const FETCH_TIMEOUT_MS = 15000;
const CURL_TIMEOUT_S = 30;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(message) {
  console.log(`[sitemap-scout] ${message}`);
}

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function normalizeUrl(raw) {
  const cleaned = decodeXmlEntities(String(raw).trim());
  if (!/^https?:\/\//i.test(cleaned)) return null;
  try {
    const parsed = new URL(cleaned);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function dedupe(list) {
  return [...new Set(list)];
}

function histogram(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// HTTP layer: native fetch first, curl fallback (blocks Node's TLS fingerprint)
// ---------------------------------------------------------------------------

async function curlGet(url) {
  const args = [
    '-sS',
    '-L',
    '--compressed',
    '-A',
    USER_AGENT,
    '--max-time',
    String(CURL_TIMEOUT_S),
    '-w',
    '\n__SCOUT_CODE__:%{http_code}',
    url,
  ];
  const { stdout } = await execFileAsync('curl', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: (CURL_TIMEOUT_S + 5) * 1000,
  });
  const marker = stdout.lastIndexOf('\n__SCOUT_CODE__:');
  if (marker === -1) return { status: 0, text: stdout, via: 'curl' };
  const status = Number.parseInt(stdout.slice(marker + '\n__SCOUT_CODE__:'.length).trim(), 10);
  return { status: Number.isFinite(status) ? status : 0, text: stdout.slice(0, marker), via: 'curl' };
}

/**
 * Fetch a URL as text. Uses native fetch with a browser-like User-Agent and
 * automatically falls back to `curl` whenever fetch fails or returns an HTTP
 * error status (several sites reject Node's TLS fingerprint).
 */
async function fetchText(url) {
  let fetchStatus = 0;
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (response.ok) {
      return { status: response.status, text: await response.text(), via: 'fetch', ok: true };
    }
    fetchStatus = response.status;
  } catch {
    fetchStatus = 0;
  }

  try {
    const fallback = await curlGet(url);
    return {
      status: fallback.status || fetchStatus,
      text: fallback.text,
      via: 'curl',
      ok: fallback.status >= 200 && fallback.status < 300,
      fetchStatus,
    };
  } catch (error) {
    return {
      status: fetchStatus,
      text: '',
      via: 'fetch',
      ok: false,
      fetchStatus,
      error: `fetch status ${fetchStatus || 'error'}; curl failed: ${error.message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Sitemap parsing (urlset + sitemapindex, nested up to MAX_SITEMAP_DEPTH)
// ---------------------------------------------------------------------------

function extractLocs(xml) {
  const locs = [];
  const re = /<loc>([\s\S]*?)<\/loc>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const url = normalizeUrl(match[1]);
    if (url) locs.push(url);
  }
  return locs;
}

function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

async function walkSitemap(url, depth, state) {
  if (state.urls.length >= MAX_SITEMAP_URLS) return;
  if (state.visited.has(url)) return;
  state.visited.add(url);

  const response = await fetchText(url);
  if (!response.ok) {
    state.errors.push({ url, status: response.status, via: response.via });
    return;
  }

  const xml = response.text;
  if (isSitemapIndex(xml)) {
    state.indexFiles.push(url);
    const children = extractLocs(xml);
    if (depth >= MAX_SITEMAP_DEPTH) {
      state.skippedBeyondDepth += children.length;
      return;
    }
    for (const child of children) {
      if (state.urls.length >= MAX_SITEMAP_URLS) return;
      await walkSitemap(child, depth + 1, state);
    }
    return;
  }

  state.pageSitemaps.push(url);
  for (const loc of extractLocs(xml)) {
    if (state.urls.length >= MAX_SITEMAP_URLS) break;
    state.urls.push(loc);
  }
}

// ---------------------------------------------------------------------------
// JSON-LD detection
// ---------------------------------------------------------------------------

const LD_JSON_BLOCK_RE =
  /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** JSON-LD in the wild is sometimes technically invalid (literal control
 *  characters inside strings). Strip them before parsing. */
function sanitizeJson(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1F\x7F]/g, ' ');
}

function collectTopLevelTypes(parsed) {
  const types = [];
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) types.push(value.trim());
    else if (Array.isArray(value)) value.forEach(add);
  };
  if (Array.isArray(parsed)) {
    for (const entry of parsed) if (entry && typeof entry === 'object') add(entry['@type']);
  } else if (parsed && typeof parsed === 'object') {
    add(parsed['@type']);
    if (Array.isArray(parsed['@graph'])) {
      for (const entry of parsed['@graph']) {
        if (entry && typeof entry === 'object') add(entry['@type']);
      }
    }
  }
  return types;
}

function extractTypesLoose(block) {
  const types = [];
  const re = /"@type"\s*:\s*"([^"]+)"/g;
  let match;
  while ((match = re.exec(block)) !== null) {
    if (match[1].trim()) types.push(match[1].trim());
  }
  return types;
}

function analyzeJsonLd(html) {
  const blocks = [...html.matchAll(LD_JSON_BLOCK_RE)].map((m) => m[1]);
  const present = blocks.length > 0;
  const types = [];
  let parseFailures = 0;

  for (const raw of blocks) {
    const cleaned = sanitizeJson(raw).trim();
    if (!cleaned) continue;
    try {
      types.push(...collectTopLevelTypes(JSON.parse(cleaned)));
    } catch {
      parseFailures += 1;
      types.push(...extractTypesLoose(cleaned));
    }
  }

  return { present, blocks: blocks.length, types: dedupe(types), parseFailures };
}

// ---------------------------------------------------------------------------
// Page sampling
// ---------------------------------------------------------------------------

async function samplePage(url) {
  const response = await fetchText(url);
  const base = {
    url,
    status: response.status,
    via: response.via,
    bytes: response.text.length,
  };
  if (!response.ok) {
    return { ...base, hasJsonLd: false, types: [], blocks: 0, error: `HTTP ${response.status}` };
  }
  const jsonLd = analyzeJsonLd(response.text);
  return {
    ...base,
    hasJsonLd: jsonLd.present,
    blocks: jsonLd.blocks,
    types: jsonLd.types,
    parseFailures: jsonLd.parseFailures,
  };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function renderMarkdown(results) {
  const lines = [];
  lines.push('# Sitemap Scout Results');
  lines.push('');
  lines.push(`Generated: ${results.generatedAt}`);
  lines.push('');
  lines.push('## Overview');
  lines.push('');
  lines.push('| Site | Sitemap URLs | Sampled | With JSON-LD | Top types |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const site of results.sites) {
    const topTypes = Object.entries(site.typeHistogram)
      .slice(0, 3)
      .map(([type, count]) => `${type} (${count})`)
      .join(', ');
    lines.push(
      `| ${site.site} | ${site.sitemapUrls} | ${site.pagesSampled} | ${site.pagesWithJsonLd} | ${topTypes || '-'} |`,
    );
  }
  lines.push('');

  for (const site of results.sites) {
    lines.push(`## ${site.site}`);
    lines.push('');
    lines.push(`- Sitemap: \`${site.sitemapUrl}\``);
    lines.push(`- Sitemap URLs found: ${site.sitemapUrls}`);
    lines.push(`- URLs after include filter: ${site.matchedUrls}`);
    lines.push(`- Pages sampled: ${site.pagesSampled}`);
    lines.push(`- Pages with JSON-LD: ${site.pagesWithJsonLd}`);
    lines.push(`- Sitemap index files parsed: ${site.indexFilesParsed}`);
    if (site.errors.length) {
      lines.push(`- Fetch errors: ${site.errors.length}`);
      for (const err of site.errors) lines.push(`  - ${err.url} -> HTTP ${err.status}`);
    }
    lines.push('');

    if (Object.keys(site.typeHistogram).length) {
      lines.push('### Type histogram');
      lines.push('');
      lines.push('| schema.org type | Pages |');
      lines.push('| --- | ---: |');
      for (const [type, count] of Object.entries(site.typeHistogram)) {
        lines.push(`| \`${type}\` | ${count} |`);
      }
      lines.push('');
    }

    lines.push('### Sampled pages');
    lines.push('');
    lines.push('| URL | HTTP | JSON-LD | Types |');
    lines.push('| --- | ---: | :---: | --- |');
    for (const page of site.pages) {
      lines.push(
        `| ${page.url} | ${page.status} | ${page.hasJsonLd ? 'yes' : 'no'} | ${
          page.types.length ? page.types.map((t) => `\`${t}\``).join(', ') : '-'
        } |`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { sites: 'sites.json', out: '.', concurrency: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sites') options.sites = argv[++i];
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--concurrency') options.concurrency = Number(argv[++i]) || 5;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scout.mjs [--sites sites.json] [--out .] [--concurrency 5]');
      process.exit(0);
    }
  }
  return options;
}

async function runSite(entry, concurrency) {
  const site = entry.site;
  const sitemapPath = entry.sitemap || DEFAULT_SITEMAP_PATH;
  const maxPages = Number(entry.maxPages) > 0 ? Number(entry.maxPages) : DEFAULT_MAX_PAGES;

  let sitemapUrl;
  try {
    sitemapUrl = new URL(sitemapPath, site).toString();
  } catch {
    sitemapUrl = site.replace(/\/+$/, '') + sitemapPath;
  }

  const state = { urls: [], visited: new Set(), indexFiles: [], pageSitemaps: [], errors: [], skippedBeyondDepth: 0 };
  await walkSitemap(sitemapUrl, 0, state);

  const sitemapUrls = dedupe(state.urls);

  let filter = null;
  let filterError = null;
  if (entry.include) {
    try {
      filter = new RegExp(entry.include);
    } catch (error) {
      filterError = `invalid include regex: ${error.message}`;
    }
  }

  const matched = filter ? sitemapUrls.filter((url) => filter.test(url)) : sitemapUrls;
  const sampledUrls = matched.slice(0, maxPages);

  log(`${site}: ${sitemapUrls.length} sitemap URLs, sampling ${sampledUrls.length} pages`);
  const pages = await mapPool(sampledUrls, concurrency, samplePage);

  const pagesWithJsonLd = pages.filter((page) => page.hasJsonLd).length;
  const allTypes = pages.flatMap((page) => page.types);
  const pageErrors = pages.filter((page) => page.error);

  const result = {
    site,
    sitemapUrl,
    sitemapUrls: sitemapUrls.length,
    matchedUrls: matched.length,
    pagesSampled: pages.length,
    pagesWithJsonLd,
    indexFilesParsed: state.indexFiles.length,
    pageSitemapsParsed: state.pageSitemaps.length,
    skippedBeyondDepth: state.skippedBeyondDepth,
    typeHistogram: histogram(allTypes),
    errors: [...state.errors, ...pageErrors.map((p) => ({ url: p.url, status: p.status, via: p.via }))],
    pages,
  };
  if (filterError) result.filterError = filterError;
  log(`${site}: ${pagesWithJsonLd}/${pages.length} sampled pages publish JSON-LD`);
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sitesPath = resolve(process.cwd(), options.sites);
  const outDir = resolve(process.cwd(), options.out);

  let entries;
  try {
    entries = JSON.parse(readFileSync(sitesPath, 'utf8'));
  } catch (error) {
    console.error(`[sitemap-scout] Cannot read ${sitesPath}: ${error.message}`);
    process.exit(0);
  }
  if (!Array.isArray(entries)) {
    console.error('[sitemap-scout] sites.json must be a JSON array of site objects.');
    process.exit(0);
  }

  log(`Scouting ${entries.length} site(s) from ${sitesPath}`);
  const sites = [];
  for (const entry of entries) {
    if (!entry || !entry.site) continue;
    try {
      sites.push(await runSite(entry, options.concurrency));
    } catch (error) {
      console.error(`[sitemap-scout] ${entry.site} failed: ${error.message}`);
      sites.push({
        site: entry.site,
        sitemapUrl: entry.sitemap || DEFAULT_SITEMAP_PATH,
        sitemapUrls: 0,
        matchedUrls: 0,
        pagesSampled: 0,
        pagesWithJsonLd: 0,
        indexFilesParsed: 0,
        pageSitemapsParsed: 0,
        skippedBeyondDepth: 0,
        typeHistogram: {},
        errors: [{ url: entry.sitemap || DEFAULT_SITEMAP_PATH, status: 0, via: 'n/a' }],
        pages: [],
      });
    }
  }

  const results = {
    tool: 'sitemap-scout',
    generatedAt: new Date().toISOString(),
    node: process.version,
    sites,
  };

  const jsonPath = resolve(outDir, 'results.json');
  const mdPath = resolve(outDir, 'results.md');
  writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, renderMarkdown(results), 'utf8');

  log(`Wrote ${jsonPath}`);
  log(`Wrote ${mdPath}`);
  const totalSampled = sites.reduce((sum, s) => sum + s.pagesSampled, 0);
  const totalJsonLd = sites.reduce((sum, s) => sum + s.pagesWithJsonLd, 0);
  log(`Done: ${sites.length} site(s), ${totalSampled} pages sampled, ${totalJsonLd} with JSON-LD.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`[sitemap-scout] Unexpected error: ${error.stack || error.message}`);
  process.exit(0);
});
