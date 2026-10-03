# Sitemap Scout

A free, zero-dependency Node.js CLI that discovers pages from a site's sitemap, samples them, and reports which pages publish JSON-LD structured data—and which schema.org types appear. No API key and no browser required.

Repository: https://github.com/nursatechstudio/sitemap-scout

## How it works

Sitemap Scout reads a JSON list of sites, fetches each sitemap, and follows sitemap index files (including nested indexes up to two levels). It normalizes and deduplicates HTTP(S) URLs, applies an optional regular-expression filter, and samples up to each site's `maxPages`. Pages are fetched concurrently (five at a time by default). The tool detects `application/ld+json` blocks, extracts `@type` values when possible, and writes a JSON report plus a readable Markdown report. If a server rejects Node's TLS fingerprint or returns an HTTP error, the tool retries the request with `curl`.

## Requirements

- Node.js 18 or newer
- `curl` available for sites that block Node's native fetch

There are no npm dependencies to install.

## Run locally

```sh
node scout.mjs
```

By default, the CLI reads `sites.json` and writes `results.json` and `results.md` in the current directory. Customize the input and output paths or concurrency:

```sh
node scout.mjs --sites sites.json --out . --concurrency 5
```

Example `sites.json` entry:

```json
{
  "site": "https://example.com",
  "sitemap": "/sitemap.xml",
  "maxPages": 20,
  "include": "blog|products"
}
```

`sitemap` defaults to `/sitemap.xml`; `maxPages` defaults to 20. `include` is an optional JavaScript regular expression applied to normalized sitemap URLs. Invalid entries and fetch failures are included in results; the CLI exits with code 0 so scheduled runs can still publish reports.

## Use in your repository

1. Copy `scout.mjs` and `sites.json` into your repository.
2. Add your sites and desired sample limits to `sites.json`.
3. Add the workflow below (or copy `.github/workflows/scout.yml`) to run on pushes, on a daily schedule, or manually.
4. Review the generated `results.md` candidate list before making structured-data changes.

The included GitHub Actions workflow commits updated result files when they change. It needs the repository's `contents: write` permission.

## Monetization

Sitemap Scout is free and open source. A future Pro tier may offer convenience features (larger sample limits, scheduled JSON-LD change alerts, exported CSV candidate lists) through a [Stripe Payment Link](https://buy.stripe.com/REPLACE_WITH_YOUR_PAYMENT_LINK). The core CLI remains free, with no API key requirement.

## License

MIT. See [LICENSE](LICENSE).

Built by nursatechstudio.
