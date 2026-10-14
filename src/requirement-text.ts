export interface RequirementLiteral {
  value: string;
  start: number;
  end: number;
}

/** Source offsets include the delimiters; values keep the original spelling. */
export function requirementLiterals(text: string): RequirementLiteral[] {
  const values: RequirementLiteral[] = [];
  const paired: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’", "「": "」", "『": "』" };
  for (let start = 0; start < text.length; start++) {
    const opener = text[start];
    if (opener === "'" && start > 0 && /[\p{L}\p{N}_]/u.test(text[start - 1])) continue;
    let delimiter = paired[opener];
    let width = 1;
    if (opener === "`") {
      while (text[start + width] === "`") width++;
      delimiter = "`".repeat(width);
    }
    if (!delimiter) continue;
    for (let close = start + width; close < text.length; close++) {
      if (text[close] === "\\") { close++; continue; }
      if ((opener === '"' || opener === "'") && /[\r\n]/.test(text[close])) break;
      if (!text.startsWith(delimiter, close)) continue;
      if (opener === "`" && text[close + width] === "`") continue;
      const end = close + delimiter.length;
      values.push({ value: text.slice(start + width, close), start, end });
      start = end - 1;
      break;
    }
  }
  return values;
}

/** Mask literals without changing offsets, so their punctuation is not prose. */
export function maskRequirementLiterals(text: string): string {
  let masked = "";
  let start = 0;
  for (const literal of requirementLiterals(text)) {
    masked += text.slice(start, literal.start) + "#".repeat(literal.end - literal.start);
    start = literal.end;
  }
  return masked + text.slice(start);
}

/** Return source sentences without splitting punctuation inside literals. */
export function requirementSentences(text: string): string[] {
  const prose = maskRequirementLiterals(text);
  const sentences: string[] = [];
  let start = 0;
  for (const separator of prose.matchAll(/[.!?](?=\s|$)|[。！？]|[\r\n]+/g)) {
    const end = separator.index! + separator[0].length;
    const sentence = text.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

/** Split explicitly coordinated results while preserving literals and alternatives. */
export function requirementOutcomeClauses(text: string): string[] {
  const seedMarker = maskRequirementLiterals(text).search(/\bSeed (?:data|values):|(?:种子|初始|预置)数据[：:]/i);
  const source = seedMarker < 0 ? text : text.slice(0, seedMarker);
  return requirementSentences(source).flatMap(sentence => {
    const clauses: string[] = [];
    let start = 0;
    for (const separator of maskRequirementLiterals(sentence).matchAll(/[;；]\s*|\s+(?:and|but)\s+|并且|而且|但是/gi)) {
      const clause = sentence.slice(start, separator.index).trim().replace(/[,，]$/, "");
      if (clause) clauses.push(clause);
      start = separator.index! + separator[0].length;
    }
    const tail = sentence.slice(start).trim();
    if (tail) clauses.push(tail);
    return clauses;
  });
}
