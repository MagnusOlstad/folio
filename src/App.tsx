import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

type Note = {
  id: string
  rawId: string | null
  title: string
  type: string
  description: string
  tags: string[]
  relatedIds: string[]
  createdAt: string
  classifiedByModel: boolean
  status: 'draft' | 'stable' | 'deprecated'
  staleAfter: string | null
  stale: boolean
  filedBy: string | null
  filedAt: string | null
}

type Relationship = {
  id: string
  title: string
  type: string
  description: string
  relation: string
}

type SearchResult = Note & {
  snippet: string
  score: number
}

type NoteDetail = Note & {
  content: string
  movable: boolean
  links: Relationship[]
  backlinks: Relationship[]
  suggestions: Relationship[]
}

type NoteUpdateResult = NoteDetail & {
  warning: string | null
}

type BundleFile = {
  id: string
  name: string
  directory: string
  type: string
  deletable: boolean
  movable: boolean
  filedBy: string | null
  filedAt: string | null
}

type ViewerDocument = {
  id: string
  title: string
  type: string
  description: string
  tags: string[]
  createdAt: string
  content: string
  deletable: boolean
  movable: boolean
  status: 'draft' | 'stable' | 'deprecated'
  staleAfter: string | null
  stale: boolean
  filedBy: string | null
  filedAt: string | null
  links: Relationship[]
  backlinks: Relationship[]
  suggestions: Relationship[]
}

type VersionInfo = {
  version: string
  repo: string
  latest: string | null
  latestUrl?: string
  publishedAt?: string | null
  checkError?: string | null
  updateAvailable: boolean
}

type ModelStatus = {
  online: boolean
  canLaunch: boolean
  classifierModel: string
  answerModel: string
  answerModels: string[]
  embedModel: string
  configuredModels: string[]
  missingModels: string[]
  installingModels: string[]
  warmKeepAlive: string
  askContextLength: number
  installed: string[]
  running: string[]
  embeddingCoverage: {
    conceptsEmbedded: number
    conceptsTotal: number
    chunksEmbedded: number
    chunksTotal: number
    refreshing: boolean
  }
}

type AskResult = {
  answer: string
  sources: Note[]
  model: string
  retrieval: string
}

const starterPrompt = `Met Sam after lunch. We decided the first version of the local notes app should keep raw notes immutable and only generate derived structured notes. I need to test retrieval quality this Friday.`

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function conceptUrl(id: string) {
  return `/api/concepts?path=${encodeURIComponent(id)}`
}

function resolveBundleLink(currentId: string, href?: string) {
  if (!href || href.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(href)) return null
  let [filePath] = href.split(/[?#]/)
  try {
    filePath = decodeURIComponent(filePath)
  } catch {
    return null
  }
  if (!filePath.endsWith('.md')) return null

  const segments = filePath.startsWith('/')
    ? []
    : currentId.split('/').filter(Boolean).slice(0, -1)
  for (const segment of filePath.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join('/')}`
}

function parseTags(value: string) {
  return Array.from(new Set(value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)))
}

function bundleDirectory(id: string) {
  const lastSlash = id.lastIndexOf('/')
  return lastSlash > 0 ? id.slice(0, lastSlash) : '/'
}

function hasInstalledModel(model: string, installed: string[]) {
  const canonicalName = model.includes(':') ? model : `${model}:latest`
  return installed.includes(model) || installed.includes(canonicalName)
}

function toggleTaskAtLine(content: string, lineNumber: number, checked: boolean) {
  const lines = content.split('\n')
  const lineIndex = lineNumber - 1
  const taskMarker = /^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+)\[[ xX]\]/
  if (lineIndex < 0 || lineIndex >= lines.length || !taskMarker.test(lines[lineIndex])) return null
  lines[lineIndex] = lines[lineIndex].replace(taskMarker, `$1[${checked ? 'x' : ' '}]`)
  return lines.join('\n')
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...options?.headers },
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Request failed')
  return result
}

function App() {
  const [mode, setMode] = useState<'capture' | 'search' | 'ask' | 'explore'>('capture')
  const [content, setContent] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedTag, setSelectedTag] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [question, setQuestion] = useState('')
  const [notes, setNotes] = useState<Note[]>([])
  const [files, setFiles] = useState<BundleFile[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [askModel, setAskModel] = useState('')
  const [latest, setLatest] = useState<Note | null>(null)
  const [answer, setAnswer] = useState<AskResult | null>(null)
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [selectedDocument, setSelectedDocument] = useState<ViewerDocument | null>(null)
  const [viewerLoading, setViewerLoading] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [savingLifecycle, setSavingLifecycle] = useState(false)
  const [editingNote, setEditingNote] = useState(false)
  const [editingPath, setEditingPath] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const [filePathInput, setFilePathInput] = useState('')
  const [movingFileId, setMovingFileId] = useState<string | null>(null)
  const [draggedFileId, setDraggedFileId] = useState<string | null>(null)
  const [dropDirectory, setDropDirectory] = useState<string | null>(null)
  const [editedContent, setEditedContent] = useState('')
  const [editedTags, setEditedTags] = useState('')
  const [savingContent, setSavingContent] = useState(false)
  const [confirmingSuggestion, setConfirmingSuggestion] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const [togglingService, setTogglingService] = useState<string | null>(null)
  const [installingModels, setInstallingModels] = useState(false)
  const viewerRequest = useRef(0)
  const searchRequest = useRef(0)

  useEffect(() => {
    api<Note[]>('/api/notes')
      .then(setNotes)
      .catch((error) => setMessage(error.message))

    api<VersionInfo>('/api/version')
      .then(setVersionInfo)
      .catch(() => setVersionInfo(null))

    const refreshStatus = () => {
      api<ModelStatus>('/api/status')
        .then(setStatus)
        .catch(() => setStatus(null))
    }
    refreshStatus()
    const interval = window.setInterval(refreshStatus, 10_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!viewerId) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeViewer()
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [viewerId])

  function closeViewer() {
    viewerRequest.current += 1
    setViewerId(null)
    setSelectedDocument(null)
    setViewerLoading(false)
    setConfirmingDelete(false)
    setEditingNote(false)
    setEditingPath(false)
  }

  async function saveNote() {
    if (!content.trim() || busy) return
    setBusy(true)
    setMessage('')
    setLatest(null)
    try {
      const result = await api<{ note: Note; notes: Note[]; warning: string | null; appended: boolean }>('/api/notes', {
        method: 'POST',
        body: JSON.stringify({
          content,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      })
      setNotes((current) => [result.note, ...current.filter((note) => note.id !== result.note.id)])
      setLatest(result.note)
      setContent('')
      setMessage(result.warning || (result.appended
        ? 'Captured, classified, and appended to the existing concept.'
        : 'Captured, classified, and added to your OKF bundle.'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save note')
    } finally {
      setBusy(false)
    }
  }

  async function askNotes() {
    if (!question.trim() || busy) return
    const selectedModel = status?.answerModels.includes(askModel) ? askModel : status?.answerModel
    if (!selectedModel) return
    setBusy(true)
    setMessage('')
    setAnswer(null)
    try {
      setAnswer(await api<AskResult>('/api/ask', {
        method: 'POST',
        body: JSON.stringify({
          question,
          model: selectedModel,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      }))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not search notes')
    } finally {
      setBusy(false)
    }
  }

  async function searchNotes(query = searchQuery, tag = selectedTag) {
    if (!query.trim() && !tag) return
    const requestId = ++searchRequest.current
    setSearching(true)
    setMessage('')
    try {
      const parameters = new URLSearchParams()
      if (query.trim()) parameters.set('q', query.trim())
      if (tag) parameters.set('tag', tag)
      const results = await api<SearchResult[]>(`/api/search?${parameters}`)
      if (requestId === searchRequest.current) setSearchResults(results)
    } catch (error) {
      if (requestId === searchRequest.current) setMessage(error instanceof Error ? error.message : 'Could not search notes')
    } finally {
      if (requestId === searchRequest.current) setSearching(false)
    }
  }

  function searchTag(tag: string) {
    setMode('search')
    setSelectedTag(tag)
    setSearchQuery('')
    closeViewer()
    void searchNotes('', tag)
  }

  async function openNote(id: string) {
    const requestId = ++viewerRequest.current
    setViewerId(id)
    setSelectedDocument(null)
    setConfirmingDelete(false)
    setEditingNote(false)
    setEditingPath(false)
    setConfirmingSuggestion(null)
    setViewerLoading(true)
    try {
      const note = await api<NoteDetail>(`/api/note?id=${encodeURIComponent(id)}`)
      if (requestId !== viewerRequest.current) return
      setSelectedDocument({ ...note, deletable: true })
    } catch (error) {
      if (requestId !== viewerRequest.current) return
      closeViewer()
      setMessage(error instanceof Error ? error.message : 'Could not open note')
    } finally {
      if (requestId === viewerRequest.current) setViewerLoading(false)
    }
  }

  async function openFile(id: string) {
    const requestId = ++viewerRequest.current
    setViewerId(id)
    setSelectedDocument(null)
    setConfirmingDelete(false)
    setEditingNote(false)
    setEditingPath(false)
    setConfirmingSuggestion(null)
    setViewerLoading(true)
    try {
      const document = await api<ViewerDocument>(`/api/file?path=${encodeURIComponent(id)}`)
      if (requestId !== viewerRequest.current) return
      setViewerId(document.id)
      setSelectedDocument(document)
    } catch (error) {
      if (requestId !== viewerRequest.current) return
      closeViewer()
      setMessage(error instanceof Error ? error.message : 'Could not open file')
    } finally {
      if (requestId === viewerRequest.current) setViewerLoading(false)
    }
  }

  async function openExplorer() {
    setMode('explore')
    setFilesLoading(true)
    setMessage('')
    try {
      setFiles(await api<BundleFile[]>('/api/files'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not read bundle files')
    } finally {
      setFilesLoading(false)
    }
  }

  async function reindexBundle() {
    if (reindexing) return
    setReindexing(true)
    setMessage('')
    try {
      const result = await api<{ notes: Note[]; errors: { id: string; error: string }[] }>('/api/reindex', { method: 'POST' })
      setNotes(result.notes)
      setSearchResults([])
      setAnswer(null)
      setLatest(null)
      closeViewer()
      await openExplorer()
      setMessage(result.errors.length
        ? `Reindexed the bundle with ${result.errors.length} invalid Markdown file${result.errors.length === 1 ? '' : 's'} skipped.`
        : `Reindexed ${result.notes.length} concepts from Markdown.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not reindex the bundle')
    } finally {
      setReindexing(false)
    }
  }

  async function moveFile(id: string, directory: string) {
    if (movingFileId || savingLifecycle || savingContent || deleting || !directory.trim()) return
    const viewerRequestAtStart = viewerRequest.current
    const source = files.find((file) => file.id === id)
    if (source?.directory === directory.trim()) {
      setEditingPath(false)
      setEditingFileId(null)
      return
    }

    setMovingFileId(id)
    setMessage('')
    try {
      const result = await api<{ oldId: string; newId: string; note: ViewerDocument; warning: string | null }>('/api/file/move', {
        method: 'POST',
        body: JSON.stringify({ id, directory }),
      })
      setNotes((current) => current.map((note) => note.id === result.oldId ? {
        ...note,
        id: result.newId,
        filedBy: result.note.filedBy,
        filedAt: result.note.filedAt,
      } : note))
      setFiles((current) => current.map((file) => file.id === result.oldId ? {
        ...file,
        id: result.newId,
        directory: bundleDirectory(result.newId),
        filedBy: result.note.filedBy,
        filedAt: result.note.filedAt,
      } : file))
      setLatest((current) => current?.id === result.oldId ? {
        ...current,
        id: result.newId,
        filedBy: result.note.filedBy,
        filedAt: result.note.filedAt,
      } : current)
      if (viewerRequest.current === viewerRequestAtStart && viewerId === result.oldId) {
        setViewerId(result.newId)
        setSelectedDocument(result.note)
      }
      setEditingPath(false)
      setPathInput('')
      setEditingFileId(null)
      setFilePathInput('')
      setSearchResults([])
      setAnswer(null)

      const [notesRefresh, filesRefresh] = await Promise.allSettled([
        api<Note[]>('/api/notes'),
        api<BundleFile[]>('/api/files'),
      ])
      if (notesRefresh.status === 'fulfilled') {
        setNotes(notesRefresh.value)
        setLatest((current) => current?.id === result.newId
          ? notesRefresh.value.find((note) => note.id === result.newId) || current
          : current)
      }
      if (filesRefresh.status === 'fulfilled') setFiles(filesRefresh.value)
      const refreshWarning = notesRefresh.status === 'rejected' || filesRefresh.status === 'rejected'
        ? 'The explorer lists could not be refreshed and will update when reopened.'
        : ''
      setMessage([result.warning || `Moved the note to ${result.newId} and updated bundle references.`, refreshWarning].filter(Boolean).join(' '))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not move note')
    } finally {
      setMovingFileId(null)
      setDraggedFileId(null)
      setDropDirectory(null)
    }
  }

  async function saveLifecycle() {
    if (!selectedDocument?.deletable || savingLifecycle) return
    setSavingLifecycle(true)
    setMessage('')
    try {
      const updated = await api<NoteDetail>(`/api/note?id=${encodeURIComponent(selectedDocument.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: selectedDocument.status,
          staleAfter: selectedDocument.staleAfter
            ? new Date(`${selectedDocument.staleAfter.slice(0, 10)}T00:00:00`).toISOString()
            : null,
        }),
      })
      setSelectedDocument({ ...updated, deletable: true })
      setNotes((current) => current.map((note) => note.id === updated.id ? { ...note, ...updated } : note))
      setMessage('Updated lifecycle and freshness metadata.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update lifecycle')
    } finally {
      setSavingLifecycle(false)
    }
  }

  function applyUpdatedNote(updated: NoteDetail) {
    setSelectedDocument((current) => current?.id === updated.id ? { ...updated, deletable: true } : current)
    setNotes((current) => current.map((note) => note.id === updated.id ? { ...note, ...updated } : note))
    setSearchResults((current) => current.map((note) => note.id === updated.id ? {
      ...note,
      ...updated,
      snippet: updated.content.replace(/\s+/g, ' ').trim().slice(0, 320),
    } : note))
    setLatest((current) => current?.id === updated.id ? { ...current, ...updated } : current)
    setAnswer((current) => current ? {
      ...current,
      sources: current.sources.map((note) => note.id === updated.id ? { ...note, ...updated } : note),
    } : null)
  }

  async function updateNoteContent(nextContent: string, nextTags = selectedDocument?.tags || []) {
    if (!selectedDocument?.deletable || !nextContent.trim() || savingContent) return null
    const noteId = selectedDocument.id
    setSavingContent(true)
    setMessage('')
    try {
      const { warning, ...updated } = await api<NoteUpdateResult>(`/api/note?id=${encodeURIComponent(noteId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: nextContent, tags: nextTags }),
      })
      applyUpdatedNote(updated)
      setMessage(warning || 'Updated the note and refreshed its semantic index.')
      return updated
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update note')
      return null
    } finally {
      setSavingContent(false)
    }
  }

  async function saveNoteContent() {
    const updated = await updateNoteContent(editedContent, parseTags(editedTags))
    if (!updated) return
    setEditingNote(false)
    setEditedContent('')
  }

  async function confirmSemanticSuggestion(id: string) {
    if (!selectedDocument?.deletable || confirmingSuggestion) return
    setConfirmingSuggestion(id)
    setMessage('')
    try {
      const { warning, ...updated } = await api<NoteUpdateResult>(`/api/note?id=${encodeURIComponent(selectedDocument.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ confirmRelatedId: id }),
      })
      applyUpdatedNote(updated)
      setMessage(warning || 'Added the confirmed relationship to the Markdown note.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not confirm relationship')
    } finally {
      setConfirmingSuggestion(null)
    }
  }

  async function toggleTaskCheckbox(lineNumber: number, checked: boolean) {
    if (!selectedDocument?.deletable || savingContent) return
    const previousDocument = selectedDocument
    const nextContent = toggleTaskAtLine(previousDocument.content, lineNumber, checked)
    if (!nextContent) return

    setSelectedDocument({ ...previousDocument, content: nextContent })
    const updated = await updateNoteContent(nextContent)
    if (!updated) {
      setSelectedDocument((current) => current?.id === previousDocument.id ? previousDocument : current)
    }
  }

  async function deleteSelectedNote() {
    if (!selectedDocument?.deletable || deleting) return
    setDeleting(true)
    setMessage('')
    try {
      const result = await api<{ deletedId: string; rawId: string | null }>(`/api/note?id=${encodeURIComponent(selectedDocument.id)}`, {
        method: 'DELETE',
      })
      setNotes((current) => current.filter((note) => note.id !== result.deletedId))
      setFiles((current) => current.filter((file) => file.id !== result.deletedId))
      setSearchResults((current) => current.filter((note) => note.id !== result.deletedId))
      setAnswer((current) => current ? {
        ...current,
        sources: current.sources.filter((note) => note.id !== result.deletedId),
      } : null)
      setLatest((current) => current?.id === result.deletedId ? null : current)
      closeViewer()
      setConfirmingDelete(false)
      setMessage(result.rawId
        ? `Deleted the structured note. Its raw capture remains at ${result.rawId}.`
        : 'Deleted the structured note.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not delete note')
    } finally {
      setDeleting(false)
    }
  }

  async function toggleOllamaService(service: string, model?: string) {
    if (togglingService) return
    setTogglingService(service)
    setMessage('')
    try {
      setStatus(await api<ModelStatus>(`/api/ollama/toggle/${service}`, {
        method: 'POST',
        body: JSON.stringify({ model }),
      }))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not toggle Ollama service')
    } finally {
      setTogglingService(null)
    }
  }

  async function installOllamaModels() {
    if (installingModels) return
    setInstallingModels(true)
    setMessage('')
    try {
      setStatus(await api<ModelStatus>('/api/ollama/install', { method: 'POST' }))
      setMessage('Ollama models installed and ready.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not install Ollama models')
    } finally {
      setInstallingModels(false)
    }
  }

  const configuredAnswerModels = status?.answerModels || []
  const missingModels = status?.missingModels || []
  const modelInstallInProgress = installingModels || Boolean(status?.installingModels.length)
  const selectedAnswerModel = status?.answerModels.includes(askModel) ? askModel : status?.answerModel || ''
  const selectedAnswerModelMissing = Boolean(
    status?.online
    && selectedAnswerModel
    && !hasInstalledModel(selectedAnswerModel, status.installed),
  )
  const answerUsesClassifier = selectedAnswerModel === status?.classifierModel
  const modelEndpoints = [
    { id: 'capture', label: 'Capture', model: status?.classifierModel },
    { id: 'search', label: 'Search', model: status?.embedModel },
    { id: 'ask', label: 'Ask', model: selectedAnswerModel },
  ].map((endpoint) => ({
    ...endpoint,
    state: !status
      ? 'checking'
      : !status.online
        ? 'offline'
        : !endpoint.model || !hasInstalledModel(endpoint.model, status.installed)
          ? 'missing'
          : hasInstalledModel(endpoint.model, status.running)
            ? 'online'
            : 'stopped',
  }))

  const filesByDirectory = files.reduce((groups, file) => {
    const current = groups.get(file.directory) || []
    current.push(file)
    groups.set(file.directory, current)
    return groups
  }, new Map<string, BundleFile[]>())
  const moveDirectories = [...filesByDirectory.keys()].filter((directory) => (
    directory !== '/daily'
    && !directory.startsWith('/references')
  ))
  const availableTags = Array.from(new Set(notes.flatMap((note) => note.tags))).sort((left, right) => left.localeCompare(right))

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-group">
          <a className="brand" href="#top" aria-label="Folio home">
            <span className="brand-mark">F</span>
            <span>Folio</span>
          </a>
          {versionInfo && (
            <span className="app-version" title={`Folio ${versionInfo.version}`}>v{versionInfo.version}</span>
          )}
          {versionInfo?.updateAvailable && (
            <a
              className="update-badge"
              href={versionInfo.latestUrl}
              target="_blank"
              rel="noreferrer"
              title={`Version ${versionInfo.latest} is available`}
            >
              Update to v{versionInfo.latest}
            </a>
          )}
        </div>
        <div className="ollama-status" aria-live="polite">
          <div className={`model-status ${status?.online ? 'online' : ''}`}>
            <span className="status-dot" />
            <span>Ollama {status?.online ? 'online' : 'offline'}</span>
          </div>
          {!status ? (
            <span className="model-setup-copy">Checking local models...</span>
          ) : !status.online ? (
            <div className="model-setup">
              <span>Install or start Ollama first.</span>
              <a href="https://ollama.com/download" target="_blank" rel="noreferrer">Get Ollama</a>
              <button type="button" onClick={installOllamaModels} disabled={modelInstallInProgress}>
                {modelInstallInProgress ? 'Checking...' : 'Set up'}
              </button>
            </div>
          ) : missingModels.length ? (
            <div className="model-setup">
              <span>{missingModels.length} local model{missingModels.length === 1 ? '' : 's'} required.</span>
              <button type="button" onClick={installOllamaModels} disabled={modelInstallInProgress}>
                {modelInstallInProgress ? 'Installing...' : 'Install models'}
              </button>
            </div>
          ) : (
            <div className="endpoint-statuses" aria-label="Ollama endpoint status">
              {modelEndpoints.map((endpoint) => (
                <div
                  className={`endpoint-status ${endpoint.state}`}
                  key={endpoint.label}
                  title={`${endpoint.label}: ${endpoint.model || 'checking'} (${endpoint.state})`}
                >
                  <button
                    className="model-toggle"
                    type="button"
                    onClick={() => toggleOllamaService(endpoint.id, endpoint.model)}
                    disabled={togglingService !== null}
                    aria-label={`${endpoint.state === 'online' ? 'Stop' : 'Launch'} ${endpoint.label}`}
                  >
                    <span className="toggle-symbol" aria-hidden="true" />
                  </button>
                  <span>{endpoint.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </header>

      <section className="workspace" id="top">
        <aside className="sidebar">
          <div>
            <p className="eyebrow">Knowledge bundle</p>
            <h1>Write first.<br />Organize never.</h1>
            <p className="intro">Drop in an unfinished thought. Your local agent files it, connects it, and finds it later.</p>
          </div>

          <div className="recent">
            <div className="section-heading">
              <span>Recent concepts</span>
              <span>{notes.length}</span>
            </div>
            <div className="note-list">
              {notes.slice(0, 7).map((note) => (
                <button type="button" className="note-row" key={note.id} onClick={() => openNote(note.id)}>
                    <span className={`type-pip type-${note.type.toLowerCase().replace(/\s+/g, '-')}`} />
                  <div>
                    <strong>{note.title}</strong>
                    <small>{note.type} / {formatDate(note.createdAt)}</small>
                  </div>
                </button>
              ))}
              {!notes.length && <p className="empty">Your first concepts will appear here.</p>}
            </div>
          </div>

          <p className="storage-note">Stored locally in <code>data/bundle</code></p>
        </aside>

        <section className="desk">
          <nav className="mode-switch" aria-label="Workspace mode">
            <button className={mode === 'capture' ? 'active' : ''} onClick={() => setMode('capture')}>Capture</button>
            <button className={mode === 'search' ? 'active' : ''} onClick={() => setMode('search')}>Search</button>
            <button className={mode === 'ask' ? 'active' : ''} onClick={() => setMode('ask')}>Ask your notes</button>
            <button className={mode === 'explore' ? 'active' : ''} onClick={openExplorer}>Explore files</button>
          </nav>

          {mode === 'capture' ? (
            <div className="panel capture-panel">
              <div className="panel-title">
                <div>
                  <p className="eyebrow">New capture</p>
                  <h2>What is on your mind?</h2>
                </div>
                <span>Markdown</span>
              </div>
              <textarea
                autoFocus
                value={content}
                onChange={(event) => setContent(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') saveNote()
                }}
                placeholder={starterPrompt}
                aria-label="Markdown note"
              />
              <div className="composer-footer">
                <p>Raw capture is preserved before the agent runs.</p>
                <button className="primary" disabled={!content.trim() || busy} onClick={saveNote}>
                  {busy ? 'Filing...' : 'File note'} <span>⌘↵</span>
                </button>
              </div>
            </div>
          ) : mode === 'search' ? (
            <div className="panel ask-panel">
              <div className="panel-title">
                <div>
                  <p className="eyebrow">Embedding retrieval</p>
                  <h2>Find notes by meaning.</h2>
                </div>
                <span>
                  {status?.embeddingCoverage?.refreshing
                    ? 'Indexing...'
                    : `${status?.embeddingCoverage?.conceptsEmbedded || 0}/${status?.embeddingCoverage?.conceptsTotal || 0} notes, ${status?.embeddingCoverage?.chunksEmbedded || 0}/${status?.embeddingCoverage?.chunksTotal || 0} chunks`}
                </span>
              </div>
              <div className="ask-form">
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && searchNotes()}
                  placeholder="decisions about preserving original notes"
                  aria-label="Search your notes"
                />
                <button className="primary" disabled={(!searchQuery.trim() && !selectedTag) || searching} onClick={() => searchNotes()}>
                  {searching ? 'Searching...' : 'Search'}
                </button>
              </div>
              {availableTags.length > 0 && (
                <div className="tag-filters" aria-label="Filter by tag">
                  <button
                    type="button"
                    className={!selectedTag ? 'active' : ''}
                    onClick={() => {
                      setSelectedTag('')
                      if (searchQuery.trim()) void searchNotes(searchQuery, '')
                      else {
                        searchRequest.current += 1
                        setSearching(false)
                        setSearchResults([])
                      }
                    }}
                  >
                    All tags
                  </button>
                  {availableTags.map((tag) => (
                    <button type="button" className={selectedTag === tag ? 'active' : ''} onClick={() => searchTag(tag)} key={tag}>
                      #{tag}
                    </button>
                  ))}
                </div>
              )}
              {searchResults.length ? (
                <div className="search-results">
                  {searchResults.map((result) => (
                    <article className="search-result" key={result.id}>
                      <button type="button" className="search-result-main" onClick={() => openNote(result.id)}>
                        <div className="search-result-meta">
                          <span>{result.type}</span>
                          <small>{!searchQuery.trim() && selectedTag ? `#${selectedTag}` : `${Math.round(result.score * 100)}% match`}</small>
                        </div>
                        <strong>{result.title}</strong>
                        <p>{result.description}</p>
                        <blockquote>{result.snippet}</blockquote>
                      </button>
                      <div className="result-tags">
                        {result.tags.map((tag) => (
                          <button
                            type="button"
                            key={tag}
                            onClick={() => searchTag(tag)}
                          >
                            #{tag}
                          </button>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="ask-empty">
                  <span>⌕</span>
                  <p>EmbeddingGemma and keyword matching return source notes directly. The heavy answer model is not loaded.</p>
                </div>
              )}
            </div>
          ) : mode === 'ask' ? (
            <div className="panel ask-panel">
              <div className="panel-title">
                <div>
                  <p className="eyebrow">Local synthesis</p>
                  <h2>Synthesize your knowledge.</h2>
                </div>
                <label className="answer-model" htmlFor="answer-model">
                  <span>Answer model</span>
                  <select
                    id="answer-model"
                    value={selectedAnswerModel}
                    onChange={(event) => {
                      setAskModel(event.target.value)
                      setAnswer(null)
                    }}
                    disabled={busy || !configuredAnswerModels.length}
                  >
                    {configuredAnswerModels.map((model) => {
                      const installed = !status?.online || hasInstalledModel(model, status.installed)
                      return (
                        <option key={model} value={model} disabled={!installed}>
                          {model}{installed ? '' : ' (not installed)'}
                        </option>
                      )
                    })}
                  </select>
                </label>
              </div>
              <div className="ask-form">
                <input
                  autoFocus
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && askNotes()}
                  placeholder="What did I decide last week, and what should I do next?"
                  aria-label="Question for your notes"
                />
                <button className="primary" disabled={!question.trim() || busy || selectedAnswerModelMissing} onClick={askNotes}>
                  {busy ? 'Asking...' : 'Ask'}
                </button>
              </div>
              {answer ? (
                <div className="answer">
                  <p className="eyebrow">Answer / {answer.model} / {answer.retrieval}</p>
                  <div className="answer-copy">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ href, children }) => href?.startsWith('/') ? (
                          <a
                            href={conceptUrl(href)}
                            onClick={(event) => {
                              event.preventDefault()
                              openNote(href)
                            }}
                          >
                            {children}
                          </a>
                        ) : <span className="citation">{children}</span>,
                      }}
                    >
                      {answer.answer}
                    </ReactMarkdown>
                  </div>
                  <div className="sources">
                    {answer.sources.map((source) => (
                      <button type="button" onClick={() => openNote(source.id)} key={source.id}>{source.title}</button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="ask-empty">
                  <span>?</span>
                  <p>
                    {answerUsesClassifier
                      ? `OKF metadata and embeddings retrieve relevant notes. ${selectedAnswerModel} is shared with Capture and stays warm after answering.`
                      : `OKF metadata and embeddings retrieve relevant notes. ${selectedAnswerModel || 'The selected model'} loads only when you ask, then unloads from memory.`}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="panel explorer-panel">
              <div className="panel-title">
                <div>
                  <p className="eyebrow">OKF bundle</p>
                  <h2>Explore the source files.</h2>
                </div>
                <button className="reindex-button" type="button" disabled={reindexing} onClick={reindexBundle}>
                  {reindexing ? 'Reindexing...' : `Reindex ${files.length} files`}
                </button>
              </div>
              {filesLoading ? (
                <div className="explorer-empty">Reading bundle...</div>
              ) : files.length ? (
                <div className="file-browser">
                  {[...filesByDirectory.entries()].map(([directory, directoryFiles]) => {
                    const acceptsDrop = moveDirectories.includes(directory)
                    return (
                      <section
                        className={`file-group ${acceptsDrop && dropDirectory === directory ? 'drop-target' : ''}`}
                        key={directory}
                        onDragEnter={(event) => {
                          if (!acceptsDrop) return
                          event.preventDefault()
                          if (draggedFileId || event.dataTransfer.types.includes('application/x-folio-file')) {
                            setDropDirectory(directory)
                          }
                        }}
                        onDragOver={(event) => {
                          if (!acceptsDrop) return
                          event.preventDefault()
                          event.dataTransfer.dropEffect = 'move'
                        }}
                        onDrop={(event) => {
                          if (!acceptsDrop) return
                          event.preventDefault()
                          const fileId = event.dataTransfer.getData('application/x-folio-file')
                            || event.dataTransfer.getData('text/plain')
                            || draggedFileId
                          if (fileId) void moveFile(fileId, directory)
                        }}
                      >
                        <div className="file-directory">
                          <span>{directory}</span>
                          <small>{acceptsDrop && dropDirectory === directory ? 'Move here' : directoryFiles.length}</small>
                        </div>
                        {directoryFiles.map((file) => (
                          <div className="file-row-wrap" key={file.id}>
                            <div
                              className={`file-row ${movingFileId === file.id ? 'moving' : ''}`}
                              draggable={file.movable && !movingFileId && editingFileId !== file.id}
                              title={file.movable ? 'Drag this file to another directory' : undefined}
                              onDragStart={(event) => {
                                if (!file.movable) {
                                  event.preventDefault()
                                  return
                                }
                                event.dataTransfer.effectAllowed = 'move'
                                event.dataTransfer.setData('application/x-folio-file', file.id)
                                event.dataTransfer.setData('text/plain', file.id)
                                setDraggedFileId(file.id)
                              }}
                              onDragEnd={() => {
                                setDraggedFileId(null)
                                setDropDirectory(null)
                              }}
                            >
                              <span className="file-mark">MD</span>
                              <button type="button" className="file-copy" onClick={() => openFile(file.id)}>
                                <strong>{file.name}</strong>
                                <small>{file.filedBy?.startsWith('human:') ? `${file.type} / human-filed` : file.type}</small>
                              </button>
                              {file.movable && (
                                <button
                                  type="button"
                                  className="file-path-action"
                                  disabled={Boolean(movingFileId)}
                                  onClick={() => {
                                    setEditingFileId(file.id)
                                    setFilePathInput(file.directory)
                                  }}
                                  aria-label={`Edit path for ${file.name}`}
                                >
                                  Edit path
                                </button>
                              )}
                              <button type="button" className="file-open" onClick={() => openFile(file.id)}>
                                {movingFileId === file.id ? 'Moving' : 'Open'}
                              </button>
                            </div>
                            {editingFileId === file.id && (
                              <form
                                className="file-path-editor"
                                onSubmit={(event) => {
                                  event.preventDefault()
                                  void moveFile(file.id, filePathInput)
                                }}
                              >
                                <label>
                                  <span>Directory path</span>
                                  <input
                                    autoFocus
                                    list="bundle-path-options"
                                    value={filePathInput}
                                    onChange={(event) => setFilePathInput(event.target.value)}
                                    placeholder="/projects/example"
                                    aria-label={`Directory path for ${file.name}`}
                                  />
                                </label>
                                <span className="file-path-name">/{file.name}</span>
                                <button type="button" className="secondary" onClick={() => setEditingFileId(null)}>Cancel</button>
                                <button type="submit" className="secondary" disabled={movingFileId === file.id || !filePathInput.trim()}>
                                  {movingFileId === file.id ? 'Moving...' : 'Move'}
                                </button>
                              </form>
                            )}
                          </div>
                        ))}
                      </section>
                    )
                  })}
                </div>
              ) : (
                <div className="explorer-empty">No Markdown files found in the bundle.</div>
              )}
            </div>
          )}

          {(message || latest) && (
            <div className={`result-card ${latest ? 'has-note' : ''}`}>
              <p>{message}</p>
              {latest && (
                <button type="button" className="classification" onClick={() => openNote(latest.id)}>
                  <span>{latest.type}</span>
                  <strong>{latest.title}</strong>
                  <p>{latest.description}</p>
                  <div>{latest.tags.map((tag) => <small key={tag}>#{tag}</small>)}</div>
                </button>
              )}
            </div>
          )}
        </section>
      </section>

      {viewerId && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeViewer()
            }
          }}
        >
          <section className="note-modal" role="dialog" aria-modal="true" aria-label={selectedDocument?.title || 'Loading note'}>
            <button
              type="button"
              className="modal-close"
              onClick={closeViewer}
              aria-label="Close note"
            >
              Close
            </button>
            {viewerLoading || !selectedDocument ? (
              <div className="modal-loading">Opening note...</div>
            ) : (
              <>
                <header className="modal-header">
                  <p className="eyebrow">
                    {selectedDocument.type} / {selectedDocument.status}{selectedDocument.stale ? ' / stale' : ''}
                  </p>
                  <h2>{selectedDocument.title}</h2>
                  <p>{selectedDocument.description}</p>
                  <div className="modal-meta">
                    {editingPath ? (
                      <form
                        className="path-editor"
                        onSubmit={(event) => {
                          event.preventDefault()
                          void moveFile(selectedDocument.id, pathInput)
                        }}
                      >
                        <label>
                          <span>Bundle path</span>
                          <input
                            aria-label="Bundle directory"
                            autoFocus
                            list="bundle-path-options"
                            value={pathInput}
                            onChange={(event) => setPathInput(event.target.value)}
                            placeholder="/projects/example"
                          />
                        </label>
                        <span className="path-filename">/{selectedDocument.id.split('/').at(-1)}</span>
                        <button type="button" className="secondary" disabled={movingFileId === selectedDocument.id} onClick={() => setEditingPath(false)}>Cancel</button>
                        <button type="submit" className="secondary" disabled={movingFileId === selectedDocument.id || !pathInput.trim()}>
                          {movingFileId === selectedDocument.id ? 'Moving...' : 'Move'}
                        </button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        className="path-button"
                        disabled={!selectedDocument.movable || Boolean(movingFileId) || savingLifecycle || savingContent || deleting}
                        title={selectedDocument.movable ? 'Move this note to another bundle path' : 'This OKF path is fixed'}
                        onClick={() => {
                          setPathInput(bundleDirectory(selectedDocument.id))
                          setEditingPath(true)
                          setEditingNote(false)
                        }}
                      >
                        {selectedDocument.id}
                      </button>
                    )}
                    <span>{formatDate(selectedDocument.createdAt)}</span>
                    {selectedDocument.filedBy?.startsWith('human:') && selectedDocument.filedAt && (
                      <span>Human-filed {formatDate(selectedDocument.filedAt)}</span>
                    )}
                    {selectedDocument.tags.map((tag) => (
                      <button type="button" className="tag-chip" key={tag} onClick={() => searchTag(tag)}>#{tag}</button>
                    ))}
                  </div>
                  {selectedDocument.deletable && !editingNote && !editingPath && !movingFileId && (
                    <button
                      type="button"
                      className="secondary edit-note-button"
                      onClick={() => {
                        setEditedContent(selectedDocument.content)
                        setEditedTags(selectedDocument.tags.join(', '))
                        setEditingNote(true)
                        setEditingPath(false)
                        setConfirmingDelete(false)
                      }}
                    >
                      Edit note
                    </button>
                  )}
                </header>
                {editingNote ? (
                  <div className="modal-content modal-editor">
                    <textarea
                      aria-label="Note content"
                      autoFocus
                      value={editedContent}
                      onChange={(event) => setEditedContent(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                          event.preventDefault()
                          saveNoteContent()
                        }
                      }}
                    />
                    <label className="tag-editor">
                      <span>Tags, separated by commas</span>
                      <input value={editedTags} onChange={(event) => setEditedTags(event.target.value)} />
                    </label>
                    <div className="editor-actions">
                      <p>Edit the Markdown and its search tags directly.</p>
                      <button
                        type="button"
                        className="secondary"
                        disabled={savingContent}
                        onClick={() => {
                          setEditingNote(false)
                          setEditedContent('')
                        }}
                      >
                        Cancel
                      </button>
                      <button type="button" className="primary" disabled={savingContent || !editedContent.trim()} onClick={saveNoteContent}>
                        {savingContent ? 'Saving...' : 'Save changes'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="modal-content">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ href, children }) => {
                          const linkedFile = resolveBundleLink(selectedDocument.id, href)
                          return linkedFile ? (
                            <a
                              href={conceptUrl(linkedFile)}
                              onClick={(event) => {
                                event.preventDefault()
                                openFile(linkedFile)
                              }}
                            >
                              {children}
                            </a>
                          ) : <a href={href}>{children}</a>
                        },
                        li: ({ node, ...props }) => (
                          <li {...props} data-source-line={node?.position?.start.line} />
                        ),
                        input: ({ node: _node, ...props }) => (
                          <input
                            {...props}
                            disabled={props.type !== 'checkbox' || !selectedDocument.deletable || savingContent || Boolean(movingFileId)}
                            onChange={(event) => {
                              const lineNumber = Number(event.currentTarget.closest('li')?.dataset.sourceLine)
                              if (lineNumber) toggleTaskCheckbox(lineNumber, event.currentTarget.checked)
                            }}
                          />
                        ),
                      }}
                    >
                      {selectedDocument.content}
                    </ReactMarkdown>
                  </div>
                )}
                {(selectedDocument.links.length > 0 || selectedDocument.backlinks.length > 0 || selectedDocument.suggestions.length > 0) && (
                  <section className="relationship-panel">
                    {selectedDocument.links.length > 0 && (
                      <div>
                        <p className="eyebrow">Links</p>
                        {selectedDocument.links.map((relationship) => (
                          <button type="button" key={`${relationship.id}-${relationship.relation}`} onClick={() => openFile(relationship.id)}>
                            <span>{relationship.relation}</span>
                            <strong>{relationship.title}</strong>
                            <small>{relationship.type}</small>
                          </button>
                        ))}
                      </div>
                    )}
                    {selectedDocument.backlinks.length > 0 && (
                      <div>
                        <p className="eyebrow">Linked from</p>
                        {selectedDocument.backlinks.map((relationship) => (
                          <button type="button" key={`${relationship.id}-${relationship.relation}`} onClick={() => openFile(relationship.id)}>
                            <span>{relationship.relation}</span>
                            <strong>{relationship.title}</strong>
                            <small>{relationship.type}</small>
                          </button>
                        ))}
                      </div>
                    )}
                    {selectedDocument.suggestions.length > 0 && (
                      <div>
                        <p className="eyebrow">Suggested links</p>
                        {selectedDocument.suggestions.map((relationship) => (
                          <button
                            type="button"
                            key={relationship.id}
                            disabled={Boolean(movingFileId) || confirmingSuggestion === relationship.id}
                            onClick={() => confirmSemanticSuggestion(relationship.id)}
                          >
                            <span>{confirmingSuggestion === relationship.id ? 'Adding...' : 'Confirm link'}</span>
                            <strong>{relationship.title}</strong>
                            <small>{relationship.type}</small>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                )}
                {selectedDocument.deletable && !editingNote && !editingPath && !movingFileId && (
                  <footer className="modal-actions">
                    {confirmingDelete ? (
                      <div className="delete-confirmation">
                        <p>Delete this structured note? The immutable raw capture will be kept.</p>
                        <div>
                          <button type="button" className="secondary" onClick={() => setConfirmingDelete(false)}>Cancel</button>
                          <button type="button" className="danger" disabled={deleting} onClick={deleteSelectedNote}>
                            {deleting ? 'Deleting...' : 'Delete note'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="lifecycle-controls">
                          <label>
                            <span>Status</span>
                            <select
                              value={selectedDocument.status}
                              onChange={(event) => setSelectedDocument({
                                ...selectedDocument,
                                status: event.target.value as ViewerDocument['status'],
                              })}
                            >
                              <option value="draft">Draft</option>
                              <option value="stable">Stable</option>
                              <option value="deprecated">Deprecated</option>
                            </select>
                          </label>
                          <label>
                            <span>Stale after</span>
                            <input
                              type="date"
                              value={selectedDocument.staleAfter?.slice(0, 10) || ''}
                              onChange={(event) => setSelectedDocument({ ...selectedDocument, staleAfter: event.target.value || null })}
                            />
                          </label>
                          <button type="button" className="secondary" disabled={savingLifecycle} onClick={saveLifecycle}>
                            {savingLifecycle ? 'Saving...' : 'Save lifecycle'}
                          </button>
                        </div>
                        <button type="button" className="danger subtle" onClick={() => setConfirmingDelete(true)}>Delete note</button>
                      </>
                    )}
                  </footer>
                )}
              </>
            )}
          </section>
        </div>
      )}
      <datalist id="bundle-path-options">
        {moveDirectories.map((directory) => <option value={directory} key={directory} />)}
      </datalist>
    </main>
  )
}

export default App
