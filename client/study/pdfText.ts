// Client-side PDF text extraction for uploaded materials — so the "Ask Otto" chat can reference what's
// actually in a PDF, not just its filename. Deliberately client-side and upload-only: uploaded files live
// only as a local Blob (see StudySetup.tsx's handleFiles), the server never sees the bytes, and the app's
// CSP (connect-src 'self') would block fetching a REMOTE pdf URL for extraction anyway — so this only
// handles files the student actually dropped in, not linked PDFs elsewhere on the web.
const MAX_CHARS_PER_MATERIAL = 6000;

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((mod) => {
      // Vite bundles the worker as a same-origin asset (satisfies script-src 'self') — pdf.js refuses to
      // run without a worker source configured explicitly in a bundler context.
      mod.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
      return mod;
    });
  }
  return pdfjsPromise;
}

/** Extracts up to MAX_CHARS_PER_MATERIAL of plain text from a PDF file. Returns "" on any failure (a
 *  scanned/image-only PDF, a corrupt file, an extraction error) — never throws, since this always runs as
 *  a best-effort background enhancement after the material is already usable (viewable in PDFArtifact)
 *  without it. */
export async function extractPdfText(file: File): Promise<string> {
  try {
    const pdfjs = await getPdfjs();
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    let text = "";
    for (let i = 1; i <= doc.numPages && text.length < MAX_CHARS_PER_MATERIAL; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((it: any) => ("str" in it ? it.str : "")).join(" ") + "\n\n";
    }
    return text.trim().slice(0, MAX_CHARS_PER_MATERIAL);
  } catch {
    return "";
  }
}
