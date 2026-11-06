const NORWEGIAN_WORDS = new Set(['og', 'er', 'det', 'en', 'et', 'jeg', 'ikke', 'som', 'på', 'for', 'med', 'til', 'av', 'har', 'vi', 'den', 'de', 'om', 'men', 'å', 'fra', 'kan', 'skal', 'ble', 'var', 'også', 'hva', 'når', 'må', 'noen', 'denne', 'dette', 'oss', 'meg', 'seg', 'hos', 'etter', 'mye', 'bare', 'fordi', 'gjøre'])
const ENGLISH_WORDS = new Set(['the', 'and', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'that', 'it', 'for', 'with', 'on', 'this', 'have', 'has', 'not', 'but', 'be', 'we', 'you', 'they', 'from', 'will', 'would', 'can', 'should', 'about', 'what', 'when', 'there', 'their', 'which', 'because', 'been', 'also'])

// Cheap deterministic fallback: 'no', 'en', or 'other' (too little signal or a tie).
export function detectLanguageHeuristic(text) {
  const prose = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ').replace(/https?:\/\/\S+/g, ' ')
  const words = prose.toLocaleLowerCase().match(/[\p{L}]+/gu) || []
  let norwegian = (prose.match(/[æøåÆØÅ]/g) || []).length
  let english = 0
  for (const word of words) {
    if (NORWEGIAN_WORDS.has(word)) norwegian += 1
    if (ENGLISH_WORDS.has(word)) english += 1
  }
  if (norwegian + english < 2 || norwegian === english) return 'other'
  return norwegian > english ? 'no' : 'en'
}
