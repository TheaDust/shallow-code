import { createCanvas } from "@napi-rs/canvas";

export function mediaPng(text: string): Buffer {
  const canvas = createCanvas(1000, 160), context = canvas.getContext("2d");
  context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "black"; context.font = "48px sans-serif"; context.fillText(text, 25, 85);
  context.fillStyle = "red"; context.fillRect(20, 125, 40, 20);
  return canvas.toBuffer("image/png");
}

/** Minimal valid PDF with explicit xref offsets; test fixtures contain no application source. */
export function mediaPdf(text: string, color = "1 0 0"): Buffer {
  const content = text ? `BT /F1 28 Tf 25 100 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET\n${color} rg 20 20 40 20 re f` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(source + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
