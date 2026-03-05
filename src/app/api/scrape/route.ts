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
  url: string
): Promise<{ base64: string; mime: string } | null> {
  try {
    const res = await fetchWithTimeout(url, 10000);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 100) return null;

    let mime = res.headers.get("content-type") || "image/jpeg";
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
  const byline = $('[class*="byline"], [class*="author"], [rel="author"]')
    .first()
    .text();
  if (byline) return byline.replace(/^by\s+/i, "").trim();
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

function extractBody($: cheerio.CheerioAPI): string[] {
  const paragraphs: string[] = [];
  const selectors = [
    "article p",
    '[class*="article-body"] p',
    '[class*="post-content"] p',
    '[class*="entry-content"] p',
    "main p",
    ".content p",
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 30) paragraphs.push(text);
    });
    if (paragraphs.length > 3) break;
  }

  // Fallback: just grab all p tags
  if (paragraphs.length <= 3) {
    paragraphs.length = 0;
    $("p").each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 30) paragraphs.push(text);
    });
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
  // Check header for logo
  const headerImgs = $("header img, nav img, [class*='logo'] img");
  for (let i = 0; i < headerImgs.length; i++) {
    const src = $(headerImgs[i]).attr("src");
    if (src) {
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
  // Check for any img with logo in src/alt
  const anyLogo = $('img[src*="logo"], img[alt*="logo"]').first().attr("src");
  if (anyLogo) return new URL(anyLogo, baseUrl).href;

  // Fallback to favicon
  const favicon =
    $('link[rel="icon"]').attr("href") ||
    $('link[rel="shortcut icon"]').attr("href");
  if (favicon) return new URL(favicon, baseUrl).href;

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

    // Download images in parallel
    const [heroData, logoData] = await Promise.all([
      heroImageUrl ? downloadImageAsBase64(heroImageUrl) : null,
      logoUrl ? downloadImageAsBase64(logoUrl) : null,
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
