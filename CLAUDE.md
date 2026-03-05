# Press Clipper Web — Deployment Context

## What This Is
A Next.js web app that generates formatted press clip `.docx` files from media report spreadsheets. Users upload an `.xlsx`, select rows, and download Word documents — no local tooling required.

## Project Status
- **Build**: Passes clean (`next build` succeeds)
- **Local test**: API endpoint and UI tested, working
- **NOT yet deployed** — needs `npm install` then deploy to Vercel

## Tech Stack
- **Framework**: Next.js 16 (App Router, TypeScript, Tailwind CSS v4)
- **Server**: Single API route (`/api/scrape`) using Cheerio for HTML scraping
- **Client**: XLSX parsing (SheetJS), DOCX generation (docx-js), file download (file-saver)
- **No database, no auth, no env vars needed**

## Architecture

```
Browser                          Server (Vercel Serverless)
──────                          ──────────────────────────
Upload .xlsx ──→ parse locally
Show row picker
For each selected row:
  POST /api/scrape {url} ──→   Fetch article HTML
                                Extract: title, author, date,
                                body, hero image, logo
                           ←── Return JSON (images as base64)
Generate .docx locally
Download to user
```

Key design choice: each article is scraped in a **separate API call** to stay within Vercel's serverless function timeout (10s free tier, 60s Pro). DOCX generation happens entirely client-side.

## File Structure
```
src/
├── app/
│   ├── api/scrape/route.ts   # POST endpoint — scrapes one URL, returns article data
│   ├── globals.css            # Tailwind v4 import
│   ├── layout.tsx             # Root layout
│   └── page.tsx               # Main UI — upload, row picker, progress, download
├── lib/
│   ├── generate-docx.ts       # Client-side .docx builder (combined + individual modes)
│   └── parse-xlsx.ts          # Client-side .xlsx parser with hyperlink extraction
```

## Deployment Instructions

### Option A: Vercel CLI
```bash
cd press-clipper-web
npm install
npx vercel
```
Follow prompts. No env vars or special config needed.

### Option B: GitHub → Vercel
1. Push this folder to a GitHub repo
2. Go to vercel.com/new → Import the repo
3. Framework: auto-detects Next.js
4. Click Deploy

### Option C: Local dev
```bash
cd press-clipper-web
npm install
npm run dev
```
Opens at http://localhost:3000

## Config Files
- `next.config.ts` — marks `cheerio` as external server package
- `postcss.config.mjs` — Tailwind v4 PostCSS plugin
- `tsconfig.json` — standard Next.js TypeScript config

## Known Behaviors
- **Paywalled articles** (HTTP 403): API returns `{error: "...", paywall: true}`, UI shows lock icon
- **Timeouts**: 15s fetch timeout per article. Vercel free tier has 10s function limit — most articles complete in 3-6s, but slow sites may need Pro tier
- **Image handling**: Hero images and logos are downloaded as base64, embedded directly in the .docx. WebP images work but may render as generic in older Word versions
- **Chinese/Japanese text**: Fully supported — scraper handles UTF-8 content and CJK characters

## Output Modes
- **Combined** (default): All clips in one `.docx` with page breaks between them
- **Individual**: Separate `.docx` per clip

## If Something Breaks
- Build error → run `npm install` first, ensure Node 18+
- Scrape returns empty → the site may block server-side requests (User-Agent is set to Chrome)
- DOCX won't open → check that `docx` package version is 9.x (uses ISectionOptions API)
