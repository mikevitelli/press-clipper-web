import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  AlignmentType,
  ExternalHyperlink,
  SectionType,
  convertInchesToTwip,
} from "docx";

export interface ClipData {
  title: string;
  author: string;
  date: string;
  body: string[];
  heroImageBase64: string | null;
  heroImageType: string | null;
  logoBase64: string | null;
  logoType: string | null;
  sourceUrl: string;
  outlet?: string;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function mimeToDocxType(mime: string | null): "png" | "jpg" | "gif" | "bmp" {
  if (!mime) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("bmp")) return "bmp";
  // PNG is the safest default — webp gets converted by most viewers
  return "png";
}

function getImageDimensions(base64: string): { width: number; height: number } | null {
  try {
    const bytes = base64ToUint8Array(base64);
    // PNG: width/height at bytes 16-23 in IHDR
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      if (width > 0 && height > 0) return { width, height };
    }
    // JPEG: scan for SOF0/SOF2 markers
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset < bytes.length - 8) {
        if (bytes[offset] !== 0xff) break;
        const marker = bytes[offset + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
          const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
          if (width > 0 && height > 0) return { width, height };
        }
        const len = (bytes[offset + 2] << 8) | bytes[offset + 3];
        offset += 2 + len;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function buildClipParagraphs(data: ClipData): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  // Logo — scale to fit ~200px wide, preserve aspect ratio
  if (data.logoBase64) {
    try {
      const dims = getImageDimensions(data.logoBase64);
      let logoW = 200;
      let logoH = 60;
      if (dims && dims.width > 0 && dims.height > 0) {
        const maxWidth = 250;
        const maxHeight = 80;
        const scale = Math.min(maxWidth / dims.width, maxHeight / dims.height, 1);
        logoW = Math.round(dims.width * scale);
        logoH = Math.round(dims.height * scale);
      }
      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: base64ToUint8Array(data.logoBase64),
              transformation: { width: logoW, height: logoH },
              type: mimeToDocxType(data.logoType),
            }),
          ],
        })
      );
      paragraphs.push(new Paragraph({ text: "" }));
    } catch {
      // Skip logo on error
    }
  }

  // Date
  const displayDate = formatDate(data.date);
  if (displayDate) {
    paragraphs.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: displayDate,
            font: "Arial",
            size: 20,
          }),
        ],
      })
    );
    paragraphs.push(new Paragraph({ text: "" }));
  }

  // Title
  paragraphs.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: data.title,
          font: "Arial",
          size: 24,
          bold: true,
        }),
      ],
    })
  );
  paragraphs.push(new Paragraph({ text: "" }));

  // Author
  if (data.author && data.author !== "Unknown") {
    paragraphs.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: `By ${data.author}`,
            font: "Arial",
            size: 20,
          }),
        ],
      })
    );
    paragraphs.push(new Paragraph({ text: "" }));
  }

  // Hero image — scale to max 580px wide, preserve aspect ratio
  if (data.heroImageBase64) {
    try {
      const dims = getImageDimensions(data.heroImageBase64);
      let heroW = 580;
      let heroH = 380;
      if (dims && dims.width > 0 && dims.height > 0) {
        const maxWidth = 580;
        const scale = Math.min(maxWidth / dims.width, 1);
        heroW = Math.round(dims.width * scale);
        heroH = Math.round(dims.height * scale);
      }
      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: base64ToUint8Array(data.heroImageBase64),
              transformation: { width: heroW, height: heroH },
              type: mimeToDocxType(data.heroImageType),
            }),
          ],
        })
      );
      paragraphs.push(new Paragraph({ text: "" }));
    } catch {
      // Skip hero on error
    }
  }

  // Body
  for (const para of data.body) {
    paragraphs.push(
      new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { after: 200 },
        children: [
          new TextRun({
            text: para,
            font: "Arial",
            size: 22,
          }),
        ],
      })
    );
  }

  paragraphs.push(new Paragraph({ text: "" }));

  // Source URL
  paragraphs.push(
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [
        new ExternalHyperlink({
          children: [
            new TextRun({
              text: data.sourceUrl,
              font: "Arial",
              size: 20,
              color: "0563C1",
              underline: {},
            }),
          ],
          link: data.sourceUrl,
        }),
      ],
    })
  );

  return paragraphs;
}

export async function generateCombinedDocx(clips: ClipData[]): Promise<Blob> {
  const sections = clips.map((clip, index) => ({
    properties: {
      type: index === 0 ? undefined : SectionType.NEXT_PAGE,
      page: {
        size: {
          width: convertInchesToTwip(8.5),
          height: convertInchesToTwip(11),
          orientation: "portrait" as const,
        },
        margin: {
          top: convertInchesToTwip(1),
          bottom: convertInchesToTwip(1),
          left: convertInchesToTwip(1),
          right: convertInchesToTwip(1),
        },
      },
    },
    children: buildClipParagraphs(clip),
  }));

  const doc = new Document({ sections });
  return await Packer.toBlob(doc);
}

export async function generateSingleDocx(clip: ClipData): Promise<Blob> {
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertInchesToTwip(8.5),
              height: convertInchesToTwip(11),
              orientation: "portrait" as const,
            },
            margin: {
              top: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
            },
          },
        },
        children: buildClipParagraphs(clip),
      },
    ],
  });
  return await Packer.toBlob(doc);
}
