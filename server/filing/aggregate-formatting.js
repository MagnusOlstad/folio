export function aggregateEntryContent(content, kind) {
  const lines = content.split('\n')
  const firstContentLine = lines.findIndex((line) => line.trim())
  if (firstContentLine !== -1) {
    const guide = kind === 'todo'
      ? /^(?:todo|to-do|todos|task|tasks|oppgave|oppgaver|gj[øo]rem[aå]l)(?:\s*[:=-]\s*|\s+|$)/i
      : /^(?:daily note|daily|today log|daglig|dagsnotat)(?:\s*[:=-]\s*|\s+|$)/i
    const withoutHeading = lines[firstContentLine].replace(/^#{1,6}\s*/, '')
    if (guide.test(withoutHeading)) {
      const remainder = withoutHeading.replace(guide, '').trim()
      if (remainder) lines[firstContentLine] = remainder
      else lines.splice(firstContentLine, 1)
    }
  }

  const entry = lines.join('\n').trim() || content.trim()
  if (kind !== 'todo') return entry

  const tasks = []
  for (const line of lines) {
    if (!line.trim()) continue
    const indentation = line.match(/^[\t ]*/)?.[0] || ''
    const text = line.trim()
    if (indentation && tasks.length) {
      const continuationIndent = indentation.length >= 2 ? indentation : '  '
      tasks[tasks.length - 1] += `\n${continuationIndent}${line.trimStart()}`
      continue
    }

    if (/^-\s+\[[ xX]\]/.test(text)) {
      tasks.push(text)
      continue
    }

    const checkbox = text.match(/^(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s*(.*)$/)
    if (checkbox) {
      tasks.push(`- [${checkbox[1].toLowerCase()}]${checkbox[2] ? ` ${checkbox[2]}` : ''}`)
      continue
    }

    const task = text.replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    tasks.push(`- [ ] ${task}`)
  }
  return tasks.join('\n')
}
