import mammoth from "mammoth";
import pdfParse from "pdf-parse";

export async function parseFile(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<string> {
  if (
    mimeType === "application/pdf" ||
    filename.toLowerCase().endsWith(".pdf")
  ) {
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    filename.toLowerCase().endsWith(".docx")
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (
    mimeType === "text/plain" ||
    filename.toLowerCase().endsWith(".txt")
  ) {
    return buffer.toString("utf-8");
  }

  throw new Error(`Unsupported file type: ${mimeType || filename}`);
}

export function getFileType(mimeType: string, filename: string): string {
  if (
    mimeType === "application/pdf" ||
    filename.toLowerCase().endsWith(".pdf")
  )
    return "pdf";
  if (filename.toLowerCase().endsWith(".docx")) return "docx";
  if (mimeType === "text/plain" || filename.toLowerCase().endsWith(".txt"))
    return "txt";
  return "unknown";
}

/**
 * Split text into overlapping chunks approximating ~512 tokens each.
 * Token approximation: 1 token ≈ 0.75 words, so:
 *   512 tokens ≈ 384 words  → chunkSize = 400 words
 *    50 tokens ≈  38 words  → overlap    =  40 words
 */
export function chunkText(text: string, chunkSize = 400, overlap = 40): string[] {
  const chunks: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
    start = end - overlap;
  }

  return chunks;
}
