// Transcript notes carry `[01:23]` timestamps and `**Speaker 1** [01:23]` turn headers (the label may be any resolved speaker name). They help
// readers but add noise tokens to embeddings, so the semantic index sees the spoken text only. A real speaker name stays as a `Name: `
// prefix of the turn; default (`Speaker 2`) and unresolved (`{{speaker3}}`) labels are dropped with the header.
const TIMESTAMP = String.raw`\[(?:\d{1,2}:)?\d{1,2}:\d{2}\]`
const SPEAKER_HEADER = new RegExp(String.raw`^[ \t]*\*\*([^*\r\n]+)\*\*[ \t]+${TIMESTAMP}[ \t]*(?:\r?\n|(?![^]))`, 'gm')
const DEFAULT_LABEL = /^\s*(?:speaker\s+\d+|\{\{[^{}]*\}\})\s*$/i
const LEADING_TIMESTAMP = new RegExp(String.raw`^([ \t]*)${TIMESTAMP}[ \t]+(?=\S)`, 'gm')

export function stripTranscriptMarkup(content) {
  const text = String(content)
  if (!text.includes('[')) return text
  return text
    .replace(LEADING_TIMESTAMP, '$1')
    .replace(SPEAKER_HEADER, (header, label, offset, whole) => {
      const turnFollows = /^[ \t]*\S/.test(whole.slice(offset + header.length))
      return turnFollows && !DEFAULT_LABEL.test(label) ? `${label.trim()}: ` : ''
    })
}
