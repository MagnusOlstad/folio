/** Reads audio metadata without leaving an error handler attached during cleanup. */
export async function audioDuration(file: File): Promise<number | null> {
  if (typeof Audio === 'undefined' || typeof URL.createObjectURL !== 'function') return null
  const url = URL.createObjectURL(file)
  try {
    return await new Promise((resolve) => {
      const audio = new Audio()
      let timeout: number | undefined
      let cleaned = false
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        if (timeout !== undefined) window.clearTimeout(timeout)
        audio.onloadedmetadata = null
        audio.onerror = null
        audio.src = ''
        URL.revokeObjectURL(url)
      }
      timeout = window.setTimeout(() => { cleanup(); resolve(null) }, 2_500)
      audio.preload = 'metadata'
      audio.onloadedmetadata = () => {
        const result = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null
        cleanup()
        resolve(result)
      }
      audio.onerror = () => { cleanup(); resolve(null) }
      audio.src = url
    })
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
}
