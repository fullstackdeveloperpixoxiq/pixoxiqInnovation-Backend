// Splits text into overlapping chunks of roughly `size` characters, preferring paragraph
// and sentence boundaries so each chunk stays readable on its own.

const splitLong = (paragraph, size) => {
  if (paragraph.length <= size) return [paragraph];
  const sentences = paragraph.match(/[^.!?\n]+[.!?]+["')\]]*\s*|[^.!?\n]+$/g) || [paragraph];
  const parts = [];
  let current = '';
  sentences.forEach((sentence) => {
    if ((current + sentence).length > size && current) {
      parts.push(current.trim());
      current = '';
    }
    if (sentence.length > size) {
      for (let i = 0; i < sentence.length; i += size) parts.push(sentence.slice(i, i + size).trim());
    } else {
      current += sentence;
    }
  });
  if (current.trim()) parts.push(current.trim());
  return parts;
};

export const chunkText = (text, { size = 1200, overlap = 200 } = {}) => {
  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => splitLong(p, size));

  const chunks = [];
  let current = '';
  paragraphs.forEach((p) => {
    if (current && current.length + p.length + 2 > size) {
      chunks.push(current);
      // Carry the end of the previous chunk over for context continuity
      const tail = current.slice(-overlap);
      const cut = tail.search(/\s/);
      current = cut >= 0 && overlap > 0 ? `${tail.slice(cut + 1)}\n\n${p}` : p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  });
  if (current) chunks.push(current);
  return chunks;
};
