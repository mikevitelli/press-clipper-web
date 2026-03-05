import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";

interface ScrapedArticle {
  title: string;
  author: string;
  date: string;
  body: string[];
  heroImageBase64: string | null;
  heroImageType: string | null;
  logoBase64: string | null;
  logoType: string | null;
  sourceUrl: string;
  error?: string;
}

const PAYWALL_KEYWORDS = [
  "paywall",
  "subscriber-only",
  "premium-content",
  "paid-content",
  "metered",
  "subscribe-to-read",
  "locked-content",
];

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchWithTimeout(
  url: string,
  timeout = 15000
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
      },
      redirect: "follow",
    });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function downloadImageAsBase64(
  url: string,
  minBytes = 2000
): Promise<{ base64: string; mime: string } | null> {
  try {
    // Skip SVG URLs — they can't be embedded as raster in docx
    if (url.endsWith(".svg") || url.includes(".svg?")) return null;

    const res = await fetchWithTimeout(url, 10000);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.length < minBytes) return null;

    let mime = res.headers.get("content-type") || "image/jpeg";
    // Skip SVG responses
    if (mime.includes("svg")) return null;
    // Detect from magic bytes
    if (bytes[0] === 0x89 && bytes[1] === 0x50) mime = "image/png";
    else if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = "image/jpeg";
    else if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46
    )
      mime = "image/webp";
    else if (bytes[0] === 0x47 && bytes[1] === 0x49) mime = "image/gif";

    const base64 = Buffer.from(buffer).toString("base64");
    return { base64, mime };
  } catch {
    return null;
  }
}

function extractJsonLd($: cheerio.CheerioAPI): Record<string, unknown> | null {
  try {
    const scripts = $('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length; i++) {
      const text = $(scripts[i]).html();
      if (!text) continue;
      const data = JSON.parse(text);
      // Could be an array
      const item = Array.isArray(data) ? data[0] : data;
      if (
        item &&
        (item["@type"] === "NewsArticle" ||
          item["@type"] === "Article" ||
          item["@type"] === "BlogPosting" ||
          item["@type"] === "WebPage")
      ) {
        return item;
      }
      // Try nested @graph
      if (item?.["@graph"]) {
        for (const node of item["@graph"]) {
          if (
            node["@type"] === "NewsArticle" ||
            node["@type"] === "Article" ||
            node["@type"] === "BlogPosting"
          ) {
            return node;
          }
        }
      }
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function extractTitle(
  $: cheerio.CheerioAPI,
  jsonLd: Record<string, unknown> | null
): string {
  if (jsonLd?.headline) return String(jsonLd.headline);
  const ogTitle = $('meta[property="og:title"]').attr("content");
  if (ogTitle) return ogTitle;
  const titleTag = $("title").text();
  if (titleTag) return titleTag.split("|")[0].split("-")[0].trim();
  const h1 = $("h1").first().text();
  if (h1) return h1.trim();
  return "Untitled";
}

function cleanAuthorText(raw: string): string {
  // Strip CSS rules that sometimes get scraped alongside author names
  let text = raw.replace(/\{[^}]*\}/g, "");
  // Strip remaining CSS selectors (e.g. .class_name, @media...)
  text = text.replace(/\.[a-zA-Z_][\w-]*(?:\s*,\s*\.[a-zA-Z_][\w-]*)*/g, "");
  text = text.replace(/@media[^{]*$/g, "");
  // Strip stray CSS-like tokens
  text = text.replace(/!important/g, "");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();
  // Extract "By Author Name" if present
  const byMatch = text.match(/(?:^|[\s])By\s+([A-Z][a-zA-Z\s.'-]+)/);
  if (byMatch) return byMatch[1].trim();
  return text.replace(/^by\s+/i, "").trim();
}

function extractAuthor(
  $: cheerio.CheerioAPI,
  jsonLd: Record<string, unknown> | null
): string {
  if (jsonLd?.author) {
    const author = jsonLd.author;
    if (typeof author === "string") return author;
    if (Array.isArray(author))
      return author.map((a: { name?: string }) => a.name || "").join(", ");
    if (typeof author === "object" && author !== null && "name" in author)
      return String((author as { name: string }).name);
  }
  const metaAuthor = $('meta[name="author"]').attr("content");
  if (metaAuthor) return metaAuthor;
  // Remove style tags before extracting byline to avoid CSS pollution
  const bylineEl = $('[class*="byline"], [class*="author"], [rel="author"]').first();
  bylineEl.find("style, script").remove();
  const byline = bylineEl.text();
  if (byline) return cleanAuthorText(byline);
  return "Unknown";
}

function extractDate(
  $: cheerio.CheerioAPI,
  jsonLd: Record<string, unknown> | null
): string {
  if (jsonLd?.datePublished) return String(jsonLd.datePublished);
  const metaDate =
    $('meta[property="article:published_time"]').attr("content") ||
    $('meta[name="date"]').attr("content");
  if (metaDate) return metaDate;
  const timeTag = $("time[datetime]").first().attr("datetime");
  if (timeTag) return timeTag;
  return "";
}

const BOILERPLATE_PATTERNS = [
  /subscribe|subscription|newsletter/i,
  /sign\s*up|sign\s*in|log\s*in/i,
  /terms\s+of\s+service|privacy\s+policy/i,
  /cookie|consent/i,
  /click(ing)?\s+(here|submit|below)/i,
  /opt\s*out|unsubscribe/i,
  /all\s+rights\s+reserved/i,
  /©\s*\d{4}/,
  /share\s+(this|on|via)/i,
  /follow\s+us/i,
  /related\s+(articles?|stories|posts)/i,
  /read\s+more|continue\s+reading/i,
  /advertisement|sponsored/i,
  /you\s+(may|might)\s+also\s+like/i,
  /recommended\s+for\s+you/i,
];

function isBoilerplate(text: string): boolean {
  return BOILERPLATE_PATTERNS.some((pattern) => pattern.test(text));
}

function extractBody($: cheerio.CheerioAPI): string[] {
  const paragraphs: string[] = [];
  // Check if a paragraph is inside a non-content container we should skip.
  // Be careful: Squarespace puts classes like 'newsletter-style-dark' on <body>,
  // and 'has-comments' on <article>, so broad class* selectors cause false positives.
  // Only exclude specific container types, not body/article/main/section.
  const SAFE_TAGS = new Set(["HTML", "BODY", "ARTICLE", "MAIN", "SECTION"]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isExcluded = (el: cheerio.Cheerio<any>): boolean => {
    let node = el.parent();
    while (node.length > 0) {
      const tag = (node.prop("tagName") || "").toUpperCase();
      if (SAFE_TAGS.has(tag)) { node = node.parent(); continue; }
      const cls = (node.attr("class") || "").toLowerCase();
      const nodeName = tag.toLowerCase();
      if (nodeName === "form" || nodeName === "aside") return true;
      if (nodeName === "footer" || nodeName === "nav") return true;
      if (cls.includes("sidebar") || cls.includes("signup") || cls.includes("newsletter-form")) return true;
      if (cls.includes("comment-list") || cls.includes("comments-section")) return true;
      node = node.parent();
    }
    return false;
  };

  const seen = new Set<string>();
  const addParagraph = (text: string) => {
    // Skip if we already have a paragraph that contains this text (sub-paragraph)
    // or if this text contains an existing paragraph (parent that includes child text)
    for (const existing of seen) {
      if (existing.includes(text) || text.includes(existing)) {
        if (text.length > existing.length) {
          // Replace the shorter one with the longer version
          seen.delete(existing);
          const idx = paragraphs.indexOf(existing);
          if (idx !== -1) paragraphs.splice(idx, 1);
          break;
        }
        return;
      }
    }
    if (!seen.has(text)) {
      seen.add(text);
      paragraphs.push(text);
    }
  };

  // Phase 1: Try <p> tags inside article containers
  const pSelectors = [
    "article p",
    '[class*="article-body"] p',
    '[class*="post-content"] p',
    '[class*="entry-content"] p',
    '[class*="story-body"] p',
    '[class*="article-content"] p',
    '[class*="post-body"] p',
    "main p",
    ".content p",
  ];

  for (const sel of pSelectors) {
    $(sel).each((_, el) => {
      if (isExcluded($(el))) return;
      const text = $(el).text().trim();
      if (text.length > 30 && !isBoilerplate(text)) addParagraph(text);
    });
    if (paragraphs.length > 3) break;
  }

  // Phase 2: Fallback — all <p> tags
  if (paragraphs.length <= 3) {
    paragraphs.length = 0;
    seen.clear();
    $("p").each((_, el) => {
      if (isExcluded($(el))) return;
      const text = $(el).text().trim();
      if (text.length > 30 && !isBoilerplate(text)) addParagraph(text);
    });
  }

  // Phase 3: Fallback — look for text in <div> elements (some sites don't use <p> tags)
  if (paragraphs.length <= 1) {
    const divSelectors = [
      "article div",
      '[class*="article-body"] div',
      '[class*="post-content"] div',
      '[class*="entry-content"] div',
      '[class*="story-body"] div',
      '[class*="article-content"] div',
      "main div",
    ];

    for (const sel of divSelectors) {
      $(sel).each((_, el) => {
        if (isExcluded($(el))) return;
        // Only grab leaf-ish divs (no nested block elements with substantial text)
        const childBlocks = $(el).children("div, p, article, section, ul, ol");
        if (childBlocks.length > 0) return;
        const text = $(el).text().trim();
        if (text.length > 30 && !isBoilerplate(text)) addParagraph(text);
      });
      if (paragraphs.length > 3) break;
    }
  }

  // Phase 4: Last resort — extract text blocks from the main content area directly
  if (paragraphs.length <= 1) {
    const contentEl = $("article, main, [class*='article'], [class*='content'], [role='main']").first();
    if (contentEl.length) {
      // Remove non-content elements
      const clone = contentEl.clone();
      clone.find("script, style, nav, footer, aside, header, form, iframe, [class*='sidebar'], [class*='comment'], [class*='related'], [class*='newsletter'], [class*='signup']").remove();
      const fullText = clone.text();
      // Split into paragraphs by double newlines or significant whitespace gaps
      const chunks = fullText.split(/\n\s*\n/).map(s => s.replace(/\s+/g, " ").trim()).filter(s => s.length > 30 && !isBoilerplate(s));
      if (chunks.length > paragraphs.length) {
        paragraphs.length = 0;
        seen.clear();
        for (const chunk of chunks) {
          addParagraph(chunk);
        }
      }
    }
  }

  return paragraphs;
}

function extractHeroImage(
  $: cheerio.CheerioAPI,
  jsonLd: Record<string, unknown> | null
): string | null {
  if (jsonLd?.image) {
    const img = jsonLd.image;
    if (typeof img === "string") return img;
    if (Array.isArray(img) && typeof img[0] === "string") return img[0];
    if (typeof img === "object" && img !== null && "url" in img)
      return String((img as { url: string }).url);
  }
  const ogImage = $('meta[property="og:image"]').attr("content");
  if (ogImage) return ogImage;
  // First large image in article
  const articleImg = $("article img, main img").first().attr("src");
  if (articleImg) return articleImg;
  return null;
}

function extractLogo(
  $: cheerio.CheerioAPI,
  baseUrl: string
): string | null {
  // Check header for logo — prefer actual logo images over favicons
  const headerImgs = $("header img, nav img, [class*='logo'] img");
  for (let i = 0; i < headerImgs.length; i++) {
    const src = $(headerImgs[i]).attr("src");
    if (src && !src.endsWith(".svg") && !src.includes(".svg?")) {
      const alt = ($(headerImgs[i]).attr("alt") || "").toLowerCase();
      const className = ($(headerImgs[i]).attr("class") || "").toLowerCase();
      if (
        alt.includes("logo") ||
        className.includes("logo") ||
        src.includes("logo")
      ) {
        return new URL(src, baseUrl).href;
      }
    }
  }
  // Check for any img with logo in src/alt (skip SVGs)
  const logoImgs = $('img[src*="logo"], img[alt*="logo"]');
  for (let i = 0; i < logoImgs.length; i++) {
    const src = $(logoImgs[i]).attr("src");
    if (src && !src.endsWith(".svg") && !src.includes(".svg?")) {
      return new URL(src, baseUrl).href;
    }
  }

  // Try apple-touch-icon (higher quality than favicon, typically 180x180+)
  const touchIcon = $('link[rel="apple-touch-icon"]').attr("href");
  if (touchIcon) return new URL(touchIcon, baseUrl).href;

  // No favicon fallback — favicons are too small for print docs
  return null;
}

function checkPaywall($: cheerio.CheerioAPI, html: string): boolean {
  const htmlLower = html.toLowerCase();
  for (const keyword of PAYWALL_KEYWORDS) {
    if (htmlLower.includes(keyword)) return true;
  }
  // Check for common paywall class patterns
  if (
    $('[class*="paywall"]').length > 0 ||
    $('[class*="subscriber"]').length > 0
  ) {
    return true;
  }
  return false;
}

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();
    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    // Fetch the page
    let res: Response;
    try {
      res = await fetchWithTimeout(url);
    } catch (e) {
      return NextResponse.json(
        { error: `Failed to fetch: ${e instanceof Error ? e.message : "timeout"}` },
        { status: 502 }
      );
    }

    if (res.status === 403 || res.status === 401) {
      return NextResponse.json(
        { error: `Paywall or access denied (HTTP ${res.status})`, paywall: true },
        { status: 200 }
      );
    }

    if (!res.ok) {
      return NextResponse.json(
        { error: `HTTP ${res.status}: ${res.statusText}` },
        { status: 200 }
      );
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // Check for paywall
    if (checkPaywall($, html)) {
      return NextResponse.json(
        { error: "Paywall detected", paywall: true },
        { status: 200 }
      );
    }

    const jsonLd = extractJsonLd($);
    const title = extractTitle($, jsonLd);
    const author = extractAuthor($, jsonLd);
    const dateStr = extractDate($, jsonLd);
    const body = extractBody($);
    const heroImageUrl = extractHeroImage($, jsonLd);
    const logoUrl = extractLogo($, url);

    // Download images in parallel (hero needs 5KB+, logo needs 2KB+)
    const [heroData, logoData] = await Promise.all([
      heroImageUrl ? downloadImageAsBase64(heroImageUrl, 5000) : null,
      logoUrl ? downloadImageAsBase64(logoUrl, 2000) : null,
    ]);

    const article: ScrapedArticle = {
      title,
      author,
      date: dateStr,
      body,
      heroImageBase64: heroData?.base64 || null,
      heroImageType: heroData?.mime || null,
      logoBase64: logoData?.base64 || null,
      logoType: logoData?.mime || null,
      sourceUrl: url,
    };

    return NextResponse.json(article);
  } catch (e) {
    return NextResponse.json(
      { error: `Scraping failed: ${e instanceof Error ? e.message : "Unknown error"}` },
      { status: 500 }
    );
  }
}
