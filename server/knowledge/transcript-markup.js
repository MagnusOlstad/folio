// Transcript notes carry `[01:23]` timestamps and `**Speaker 1** [01:23]` turn headers. They help
// readers but add noise tokens to embeddings, so the semantic index sees the spoken text only.
const TIMESTAMP = String.raw`\[(?:\d{1,2}:)?\d{1,2}:\d{2}\]`
const SPEAKER_HEADER = new RegExp(String.raw`^[ \t]*\*\*Speaker \d+\*\*[ \t]+${TIMESTAMP}[ \t]*\n`, 'gm')
const LEADING_TIMESTAMP = new RegExp(String.raw`^([ \t]*)${TIMESTAMP}[ \t]+(?=\S)`, 'gm')

export function stripTranscriptMarkup(content) {
  const text = String(content)
  if (!text.includes('[')) return text
  return text.replace(SPEAKER_HEADER, '').replace(LEADING_TIMESTAMP, '$1')
}
