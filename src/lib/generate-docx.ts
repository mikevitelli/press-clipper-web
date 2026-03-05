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

  // Logo
  if (data.logoBase64) {
    try {
      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: base64ToUint8Array(data.logoBase64),
              transformation: { width: 180, height: 60 },
              type: "png",
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

  // Hero image
  if (data.heroImageBase64) {
    try {
      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: base64ToUint8Array(data.heroImageBase64),
              transformation: { width: 580, height: 380 },
              type: "png",
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
