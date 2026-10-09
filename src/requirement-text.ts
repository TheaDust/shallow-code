/** Mask data/UI literals without changing offsets, so their punctuation is not prose. */
export function maskRequirementLiterals(text: string): string {
  return text.replace(/`[^`]*`|"[^"\n]*"|“[^”]*”|‘[^’]*’/g, literal => "#".repeat(literal.length));
}

/** Return source sentences without splitting punctuation inside literals. */
export function requirementSentences(text: string): string[] {
  const prose = maskRequirementLiterals(text);
  const sentences: string[] = [];
  let start = 0;
  for (const separator of prose.matchAll(/[.!?](?=\s|$)|[\r\n]+/g)) {
    const end = separator.index! + separator[0].length;
    const sentence = text.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}
