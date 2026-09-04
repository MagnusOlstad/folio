import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { applyFormatMarker, type FormatMarker } from './markdown-format.ts'
import './App.css'

declare global {
  interface Window {
    folio?: {
      onMenuAction?: (handler: (action: string) => void) => () => void
      closeWindow?: () => void
    }
  }
}

type AppShortcutAction = 'new-note' | 'close-tab' | 'save' | 'search' | FormatMarker

const KEYBOARD_SHORTCUTS: Record<string, AppShortcutAction> = {
  t: 'new-note',
  w: 'close-tab',
  s: 'save',
  f: 'search',
  b: 'bold',
  i: 'italic',
  k: 'link',
}

const MENU_ACTIONS = new Set<string>(Object.values(KEYBOARD_SHORTCUTS))

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
  createdAt: string
  relation: string
  origin: 'frontmatter' | 'content' | 'semantic'
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

type FileMoveResult = {
  oldId: string
  newId: string
  warning: string | null
  note: ViewerDocument
}

type BundleFile = {
  id: string
  name: string
  title: string
  createdAt: string
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
  updatedAt?: string
}

type StoredDraft = {
  id: string
  content: string
  createdAt: string
  updatedAt: string
}

type VersionInfo = {
  version: string
  repo: string
  latest: string | null
  latestUrl?: string
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

type SidebarMode = 'explore' | 'search' | 'ask'

type TabGroup = {
  id: string
  tabs: string[]
  activeId: string | null
}

type TreeDirectory = {
  name: string
  path: string
  directories: TreeDirectory[]
  files: BundleFile[]
}

type EditorIntent = {
  lineNumber: number
  scrollTop: number
}

type ExpandedDirectoryState = {
  directories: Set<string>
  restored: boolean
}

type MarkdownNode = {
  position?: {
    start: { line: number }
    end: { line: number }
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
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

function directoryForId(id: string) {
  const directory = id.split('/').slice(0, -1).join('/')
  return directory || '/'
}

function normalizeDirectoryInput(value: string) {
  const parts = value.trim().replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.length ? `/${parts.join('/')}` : '/'
}

function hasInstalledModel(model: string, installed: string[]) {
  const canonicalName = model.includes(':') ? model : `${model}:latest`
  return installed.includes(model) || installed.includes(canonicalName)
}

function isUntitledId(id: string) {
  return id.startsWith('untitled:')
}

function filedDraftContent(value: string) {
  const firstLineBreak = value.indexOf('\n')
  return firstLineBreak === -1 ? value : value.slice(firstLineBreak + 1)
}

function loadExpandedDirectoryState(): ExpandedDirectoryState {
  try {
    const stored = window.localStorage.getItem('folio:expanded-directories')
    if (stored === null) return { directories: new Set(), restored: false }
    const parsed = JSON.parse(stored)
    if (!Array.isArray(parsed)) throw new Error('Invalid expanded directory state')
    return {
      directories: new Set(parsed.filter((path): path is string => typeof path === 'string')),
      restored: true,
    }
  } catch {
    return { directories: new Set(), restored: false }
  }
}

function expandedPathsForFiles(files: BundleFile[]) {
  const expanded = new Set<string>(['/'])
  for (const file of files) {
    let currentPath = ''
    for (const segment of file.directory.split('/').filter(Boolean)) {
      currentPath += `/${segment}`
      expanded.add(currentPath)
    }
  }
  return expanded
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
  let response: Response
  try {
    response = await fetch(url, {
      ...options,
      headers: { 'content-type': 'application/json', ...options?.headers },
    })
  } catch {
    throw new Error('The local Folio service is not ready yet.')
  }
  const body = await response.text()
  let result: unknown = null
  if (body) {
    try {
      result = JSON.parse(body)
    } catch {
      throw new Error(response.ok
        ? 'The server returned an invalid response.'
        : [502, 503, 504].includes(response.status)
          ? 'The local Folio service is not ready yet.'
          : `Request failed (${response.status}).`)
    }
  }
  if (!response.ok) {
    const error = result && typeof result === 'object' && 'error' in result
      ? String(result.error)
      : [502, 503, 504].includes(response.status)
        ? 'The local Folio service is not ready yet.'
        : `Request failed (${response.status}).`
    throw new Error(error)
  }
  return result as T
}

async function apiWithRetry<T>(url: string, options?: RequestInit, attempts = 8): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await api<T>(url, options)
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, Math.min(250 * 2 ** attempt, 1500)))
      }
    }
  }
  throw lastError
}

function draftTitle(content: string) {
  const firstLine = content
    .split('\n')
    .map((line) => line.replace(/^\s*#+\s*/, '').trim())
    .find(Boolean)
  return firstLine ? firstLine.slice(0, 48) : 'Untitled'
}

function sourcePosition(node?: MarkdownNode) {
  return {
    'data-source-line': node?.position?.start.line,
    'data-source-end-line': node?.position?.end.line,
  }
}

function lineStartOffset(value: string, lineNumber: number) {
  let offset = 0
  for (let line = 1; line < lineNumber; line += 1) {
    const lineBreak = value.indexOf('\n', offset)
    if (lineBreak === -1) return value.length
    offset = lineBreak + 1
  }
  return offset
}

function storedDraftDocument(draft: StoredDraft): ViewerDocument {
  return {
    id: draft.id,
    title: 'Untitled',
    type: 'Local draft',
    description: '',
    tags: [],
    createdAt: draft.createdAt,
    content: draft.content,
    deletable: true,
    movable: false,
    status: 'draft',
    staleAfter: null,
    stale: false,
    filedBy: null,
    filedAt: null,
    links: [],
    backlinks: [],
    suggestions: [],
    updatedAt: draft.updatedAt,
  }
}

function NoteEditor({
  value,
  onChange,
  onBlur,
  onFile,
  steered = false,
  intent,
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  onBlur: (scrollTop: number) => void
  onFile?: () => void
  steered?: boolean
  intent?: EditorIntent
  ariaLabel: string
}) {
  const shellRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const initialValue = useRef(value)
  const pendingSelection = useRef<[number, number] | null>(null)
  const [steeringHeight, setSteeringHeight] = useState(0)
  const placeholder = 'Optional: steer the title or path here. Press Enter to let the agent decide.'
  const firstLine = value.split('\n', 1)[0]
  const measuredFirstLine = firstLine || (!value ? placeholder : ' ')

  useLayoutEffect(() => {
    if (!steered) return
    const shell = shellRef.current
    const measure = measureRef.current
    if (!shell || !measure) return
    const updateHeight = () => setSteeringHeight(Math.ceil(measure.getBoundingClientRect().height))
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(shell)
    return () => observer.disconnect()
  }, [measuredFirstLine, steered])

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const frame = window.requestAnimationFrame(() => {
      editor.focus({ preventScroll: true })
      if (!intent) return
      const offset = lineStartOffset(initialValue.current, intent.lineNumber)
      editor.setSelectionRange(offset, offset)
      editor.scrollTop = intent.scrollTop
    })
    return () => window.cancelAnimationFrame(frame)
  }, [intent])

  useLayoutEffect(() => {
    const selection = pendingSelection.current
    if (!selection) return
    pendingSelection.current = null
    const editor = editorRef.current
    if (!editor) return
    editor.setSelectionRange(selection[0], selection[1])
  }, [value])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const format = (event: Event) => {
      const marker = (event as CustomEvent<FormatMarker>).detail
      if (marker !== 'bold' && marker !== 'italic' && marker !== 'link') return
      event.preventDefault()
      const result = applyFormatMarker(editor.value, editor.selectionStart, editor.selectionEnd, marker)
      pendingSelection.current = [result.selectionStart, result.selectionEnd]
      onChange(result.value)
    }
    editor.addEventListener('folio-format', format)
    return () => editor.removeEventListener('folio-format', format)
  }, [onChange])

  const editor = (
    <textarea
      className="document-editor"
      ref={editorRef}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={(event) => onBlur(event.currentTarget.scrollTop)}
      onKeyDown={(event) => {
        if (onFile && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault()
          onFile()
        }
      }}
      aria-label={ariaLabel}
    />
  )

  if (!steered) return editor

  return (
    <div className="draft-note-editor" ref={shellRef} style={{ '--steering-height': `${steeringHeight}px` } as React.CSSProperties}>
      <div className="draft-steering-band" />
      <div className="draft-steering-measure" ref={measureRef} aria-hidden="true">
        {measuredFirstLine}
      </div>
      {!value && <span className="draft-steering-placeholder" aria-hidden="true">{placeholder}</span>}
      {editor}
    </div>
  )
}

function loadLocalDrafts() {
  if (typeof window === 'undefined') return [] as ViewerDocument[]
  const storedDrafts = window.localStorage.getItem('folio:drafts') || '[]'
  try {
    const parsed: unknown = JSON.parse(storedDrafts)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((draft) => {
      if (!draft || typeof draft !== 'object') return []
      const value = draft as Record<string, unknown>
      if (typeof value.id !== 'string' || !isUntitledId(value.id) || typeof value.content !== 'string') return []
      const createdAt = typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString()
      const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : createdAt
      return [storedDraftDocument({ id: value.id, content: value.content, createdAt, updatedAt })]
    })
  } catch {
    try {
      window.localStorage.setItem(`folio:drafts-recovery:${Date.now()}`, storedDrafts)
      window.localStorage.removeItem('folio:drafts')
    } catch {
      // Leave the original value untouched when browser storage is unavailable.
    }
    return []
  }
}

function buildFileTree(files: BundleFile[]): TreeDirectory {
  type MutableTree = Omit<TreeDirectory, 'directories'> & { directories: Map<string, MutableTree> }
  const root: MutableTree = { name: 'Bundle', path: '/', directories: new Map(), files: [] }

  for (const file of files) {
    const parts = file.id.split('/').filter(Boolean)
    parts.pop()
    let current = root
    let path = ''
    for (const part of parts) {
      path += `/${part}`
      if (!current.directories.has(part)) {
        current.directories.set(part, { name: part, path, directories: new Map(), files: [] })
      }
      current = current.directories.get(part)!
    }
    current.files.push(file)
  }

  const finalize = (directory: MutableTree): TreeDirectory => ({
    name: directory.name,
    path: directory.path,
    directories: [...directory.directories.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(finalize),
    files: directory.files.sort((left, right) => (
      left.title.localeCompare(right.title)
      || right.createdAt.localeCompare(left.createdAt)
      || left.name.localeCompare(right.name)
    )),
  })

  return finalize(root)
}

function FileTree({
  directory,
  depth,
  expanded,
  draggedFileId,
  dropDirectoryPath,
  movingFileId,
  blockedFileIds,
  onToggle,
  onOpen,
  onFileDragStart,
  onFileDragEnd,
  onDirectoryDragOver,
  onMove,
}: {
  directory: TreeDirectory
  depth: number
  expanded: Set<string>
  draggedFileId: string | null
  dropDirectoryPath: string | null
  movingFileId: string | null
  blockedFileIds: Set<string>
  onToggle: (path: string) => void
  onOpen: (id: string) => void
  onFileDragStart: (id: string) => void
  onFileDragEnd: () => void
  onDirectoryDragOver: (path: string | null) => void
  onMove: (id: string, directory: string) => void
}) {
  const isExpanded = expanded.has(directory.path)
  return (
    <div className="tree-branch">
      <button
        type="button"
        className={`tree-row tree-directory ${dropDirectoryPath === directory.path ? 'drop-target' : ''}`}
        style={{ '--tree-depth': depth } as React.CSSProperties}
        onClick={() => onToggle(directory.path)}
        onDragOver={(event) => {
          if (!draggedFileId && !event.dataTransfer.types.includes('application/x-folio-file')) return
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
          onDirectoryDragOver(directory.path)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) onDirectoryDragOver(null)
        }}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          const fileId = event.dataTransfer.getData('application/x-folio-file') || draggedFileId
          if (fileId) onMove(fileId, directory.path)
          onFileDragEnd()
        }}
        aria-expanded={isExpanded}
      >
        <span className="tree-chevron">{isExpanded ? 'v' : '>'}</span>
        <span className="tree-folder" aria-hidden="true" />
        <span>{directory.name}</span>
      </button>
      {isExpanded && (
        <div>
          {directory.directories.map((child) => (
            <FileTree
              key={child.path}
              directory={child}
              depth={depth + 1}
              expanded={expanded}
              draggedFileId={draggedFileId}
              dropDirectoryPath={dropDirectoryPath}
              movingFileId={movingFileId}
              blockedFileIds={blockedFileIds}
              onToggle={onToggle}
              onOpen={onOpen}
              onFileDragStart={onFileDragStart}
              onFileDragEnd={onFileDragEnd}
              onDirectoryDragOver={onDirectoryDragOver}
              onMove={onMove}
            />
          ))}
          {directory.files.map((file) => (
            <button
              type="button"
              className={`tree-row tree-file ${draggedFileId === file.id ? 'dragging' : ''} ${movingFileId === file.id ? 'moving' : ''}`}
              style={{ '--tree-depth': depth + 1 } as React.CSSProperties}
              onClick={() => onOpen(file.id)}
              draggable={file.movable && !blockedFileIds.has(file.id) && movingFileId !== file.id}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('application/x-folio-file', file.id)
                onFileDragStart(file.id)
              }}
              onDragEnd={onFileDragEnd}
              title={file.movable ? `${file.id} - drag onto a folder to move` : `${file.id} - fixed OKF path`}
              key={file.id}
            >
              <span className="tree-file-mark">M</span>
              <span>{file.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function App() {
  const [initialExpandedDirectoryState] = useState(loadExpandedDirectoryState)
  const [documents, setDocuments] = useState<Record<string, ViewerDocument>>(() => Object.fromEntries(
    loadLocalDrafts().map((document) => [document.id, document]),
  ))
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('explore')
  const [notes, setNotes] = useState<Note[]>([])
  const [files, setFiles] = useState<BundleFile[]>([])
  const [filesLoading, setFilesLoading] = useState(true)
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(initialExpandedDirectoryState.directories)
  const [expandedDirectoriesReady, setExpandedDirectoriesReady] = useState(initialExpandedDirectoryState.restored)
  const [loadingDocuments, setLoadingDocuments] = useState<Set<string>>(() => new Set())
  const [groups, setGroups] = useState<TabGroup[]>([
    { id: 'primary', tabs: [], activeId: null },
  ])
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null)
  const [splitPosition, setSplitPosition] = useState(50)
  const [activeGroupId, setActiveGroupId] = useState('primary')
  const [draggedTab, setDraggedTab] = useState<{ documentId: string; groupId: string } | null>(null)
  const [dropGroupId, setDropGroupId] = useState<string | null>(null)
  const [draggedFileId, setDraggedFileId] = useState<string | null>(null)
  const [dropDirectoryPath, setDropDirectoryPath] = useState<string | null>(null)
  const [movingFileId, setMovingFileId] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(
    Object.values(documents)
      .filter((document) => isUntitledId(document.id))
      .map((document) => [document.id, document.content]),
  ))
  const [pathDrafts, setPathDrafts] = useState<Record<string, string>>({})
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({})
  const [savingDocuments, setSavingDocuments] = useState<Set<string>>(() => new Set())
  const [deletingDraftIds, setDeletingDraftIds] = useState<Set<string>>(() => new Set())
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedTag, setSelectedTag] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<AskResult | null>(null)
  const [asking, setAsking] = useState(false)
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [askModel, setAskModel] = useState('')
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const [message, setMessage] = useState('')
  const [reindexing, setReindexing] = useState(false)
  const [togglingService, setTogglingService] = useState<string | null>(null)
  const [installingModels, setInstallingModels] = useState(false)
  const searchRequest = useRef(0)
  const documentRequests = useRef<Record<string, number>>({})
  const saveQueues = useRef<Record<string, Promise<void>>>({})
  const draftSyncQueues = useRef<Record<string, Promise<void>>>({})
  const filingDraftIds = useRef<Set<string>>(new Set())
  const expandedDirectoriesReadyRef = useRef(initialExpandedDirectoryState.restored)
  const editorIntents = useRef<Record<string, EditorIntent>>({})
  const readerScrollPositions = useRef<Record<string, number>>({})
  const searchInputRef = useRef<HTMLInputElement>(null)
  const focusSearchPending = useRef(false)
  const runShortcutRef = useRef<((action: AppShortcutAction) => void) | null>(null)
  const documentsRef = useRef(documents)
  const draftSnapshotRef = useRef<StoredDraft[]>([])
  const untitledCounter = useRef(0)

  useEffect(() => {
    let cancelled = false
    let reconnectTimer = 0
    const reconnectMessage = 'The local Folio service is still starting. Reconnecting automatically.'

    const loadWorkspace = async () => {
      try {
        const currentStatus = await apiWithRetry<ModelStatus>('/api/status')
        if (cancelled) return
        setStatus(currentStatus)
      } catch {
        if (cancelled) return
        setFilesLoading(false)
        setStatus(null)
        setMessage(reconnectMessage)
        reconnectTimer = window.setTimeout(loadWorkspace, 2_000)
        return
      }
      const [notesResult, filesResult, draftsResult, versionResult] = await Promise.allSettled([
        api<Note[]>('/api/notes'),
        api<BundleFile[]>('/api/files'),
        api<StoredDraft[]>('/api/drafts'),
        api<VersionInfo>('/api/version'),
      ])
      if (cancelled) return
      if (notesResult.status === 'fulfilled') setNotes(notesResult.value)
      if (filesResult.status === 'fulfilled') {
        setFiles(filesResult.value)
        if (!expandedDirectoriesReadyRef.current) {
          const hasStarterGuides = filesResult.value.some((file) => file.id === '/getting-started/start-here.md')
          expandedDirectoriesReadyRef.current = true
          setExpandedDirectories(hasStarterGuides ? expandedPathsForFiles(filesResult.value) : new Set())
          setExpandedDirectoriesReady(true)
        }
      }
      if (versionResult.status === 'fulfilled') setVersionInfo(versionResult.value)
      if (draftsResult.status === 'fulfilled') mergeRemoteDrafts(draftsResult.value)
      setFilesLoading(false)
      if (notesResult.status === 'rejected' || filesResult.status === 'rejected') {
        setMessage(reconnectMessage)
        reconnectTimer = window.setTimeout(loadWorkspace, 2_000)
      } else {
        setMessage((current) => current === reconnectMessage ? '' : current)
      }
    }
    void loadWorkspace()

    const refreshStatus = () => {
      api<ModelStatus>('/api/status')
        .then(setStatus)
        .catch(() => setStatus(null))
    }
    const interval = window.setInterval(refreshStatus, 10_000)
    return () => {
      cancelled = true
      window.clearTimeout(reconnectTimer)
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    documentsRef.current = documents
    const localDrafts: StoredDraft[] = Object.values(documents)
      .filter((document) => isUntitledId(document.id))
      .map((document) => ({
        id: document.id,
        content: drafts[document.id] ?? document.content,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt || document.createdAt,
      }))
    draftSnapshotRef.current = localDrafts
    try {
      window.localStorage.setItem('folio:drafts', JSON.stringify(localDrafts))
    } catch {
      // The server copy remains authoritative when browser storage is unavailable.
    }
    const syncTimer = window.setTimeout(() => {
      for (const draft of localDrafts) queueDraftSync(draft)
    }, 450)
    return () => window.clearTimeout(syncTimer)
  }, [documents, drafts])

  useEffect(() => {
    if (!expandedDirectoriesReady) return
    try {
      window.localStorage.setItem('folio:expanded-directories', JSON.stringify([...expandedDirectories]))
    } catch {
      // Expansion persistence is optional when browser storage is unavailable.
    }
  }, [expandedDirectories, expandedDirectoriesReady])

  useEffect(() => {
    const interval = window.setInterval(() => {
      for (const draft of draftSnapshotRef.current) queueDraftSync(draft)
    }, 15_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      const action = KEYBOARD_SHORTCUTS[event.key.toLowerCase()]
      if (!action) return
      if (action === 'bold' || action === 'italic' || action === 'link') {
        const target = document.activeElement
        if (!(target instanceof HTMLTextAreaElement) || !target.classList.contains('document-editor')) return
        event.preventDefault()
        target.dispatchEvent(new CustomEvent('folio-format', { detail: action, cancelable: true }))
        return
      }
      event.preventDefault()
      runShortcutRef.current?.(action)
    }
    window.addEventListener('keydown', onKeyDown)
    const unsubscribeMenuActions = window.folio?.onMenuAction?.((action) => {
      if (MENU_ACTIONS.has(action)) runShortcutRef.current?.(action as AppShortcutAction)
    })
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      unsubscribeMenuActions?.()
    }
  }, [])

  useEffect(() => {
    if (sidebarMode !== 'search' || !focusSearchPending.current) return
    focusSearchPending.current = false
    searchInputRef.current?.focus()
  }, [sidebarMode])

  function focusSearchInput() {
    if (sidebarMode !== 'search') {
      focusSearchPending.current = true
      setSidebarMode('search')
      return
    }
    searchInputRef.current?.focus()
  }

  function saveActiveDocument() {
    const group = groups.find((candidate) => candidate.id === activeGroupId)
    const documentId = group?.activeId
    if (!documentId) return
    const activeDocument = documents[documentId]
    if (!activeDocument) return
    if (isUntitledId(documentId)) {
      fileDraft(activeDocument)
      return
    }
    if (editingKey !== `${group.id}:${documentId}`) return
    const content = drafts[documentId] ?? activeDocument.content
    if (content !== activeDocument.content) persistDocument(activeDocument, content, activeDocument.tags)
  }

  function runShortcut(action: AppShortcutAction) {
    if (action === 'new-note') {
      createNewTab()
      return
    }
    if (action === 'close-tab') {
      const group = groups.find((candidate) => candidate.id === activeGroupId)
      if (group?.activeId) closeTab(group.id, group.activeId)
      else window.folio?.closeWindow?.()
      return
    }
    if (action === 'save') {
      saveActiveDocument()
      return
    }
    if (action === 'search') {
      focusSearchInput()
      return
    }
    const target = document.activeElement
    if (target instanceof HTMLTextAreaElement && target.classList.contains('document-editor')) {
      target.dispatchEvent(new CustomEvent('folio-format', { detail: action, cancelable: true }))
    }
  }

  useLayoutEffect(() => {
    runShortcutRef.current = runShortcut
  })

  function titleForId(id: string) {
    if (isUntitledId(id)) return draftTitle(drafts[id] ?? documents[id]?.content ?? '')
    return documents[id]?.title
      || notes.find((note) => note.id === id)?.title
      || files.find((file) => file.id === id)?.name.replace(/\.md$/i, '')
      || id.split('/').at(-1)?.replace(/\.md$/i, '')
      || id
  }

  function mergeRemoteDrafts(remoteDrafts: StoredDraft[]) {
    const currentDocuments = documentsRef.current
    const acceptedDrafts = remoteDrafts.filter((draft) => {
      const local = currentDocuments[draft.id]
      return !local || draft.updatedAt > (local.updatedAt || local.createdAt)
    })
    if (!acceptedDrafts.length) return
    setDocuments((current) => ({
      ...current,
      ...Object.fromEntries(acceptedDrafts.map((draft) => [draft.id, storedDraftDocument(draft)])),
    }))
    setDrafts((current) => ({
      ...current,
      ...Object.fromEntries(acceptedDrafts.map((draft) => [draft.id, draft.content])),
    }))
  }

  function queueDraftSync(draft: StoredDraft) {
    if (filingDraftIds.current.has(draft.id)) return Promise.resolve()
    const existingQueue = draftSyncQueues.current[draft.id] || Promise.resolve()
    const sync = existingQueue
      .catch(() => undefined)
      .then(async () => {
        if (filingDraftIds.current.has(draft.id)) return
        await api<StoredDraft>(`/api/draft?id=${encodeURIComponent(draft.id)}`, {
          method: 'PUT',
          body: JSON.stringify(draft),
        })
      })
      .catch(() => undefined)
      .finally(() => {
        if (draftSyncQueues.current[draft.id] === sync) delete draftSyncQueues.current[draft.id]
      })
    draftSyncQueues.current[draft.id] = sync
    return sync
  }

  function activateTab(groupId: string, documentId: string) {
    setActiveGroupId(groupId)
    setGroups((current) => current.map((group) => group.id === groupId
      ? { ...group, activeId: documentId }
      : group))
    if (isUntitledId(documentId)) setEditingKey(`${groupId}:${documentId}`)
  }

  function createNewTab(targetGroupId = activeGroupId) {
    const id = `untitled:${Date.now()}:${++untitledCounter.current}`
    const createdAt = new Date().toISOString()
    const document: ViewerDocument = {
      id,
      title: 'Untitled',
      type: 'Local draft',
      description: '',
      tags: [],
      createdAt,
      content: '',
      deletable: true,
      movable: false,
      status: 'draft',
      staleAfter: null,
      stale: false,
      filedBy: null,
      filedAt: null,
      links: [],
      backlinks: [],
      suggestions: [],
      updatedAt: createdAt,
    }
    setDocuments((current) => ({ ...current, [id]: document }))
    setDrafts((current) => ({ ...current, [id]: '' }))
    setGroups((current) => current.map((group) => group.id === targetGroupId
      ? { ...group, tabs: [...group.tabs, id], activeId: id }
      : group))
    setActiveGroupId(targetGroupId)
    setEditingKey(`${targetGroupId}:${id}`)
  }

  function openLocalDraft(id: string, targetGroupId = activeGroupId) {
    const existingGroup = groups.find((group) => group.tabs.includes(id))
    if (existingGroup) {
      activateTab(existingGroup.id, id)
      setEditingKey(`${existingGroup.id}:${id}`)
      return
    }
    setGroups((current) => current.map((group) => group.id === targetGroupId
      ? { ...group, tabs: [...group.tabs, id], activeId: id }
      : group))
    setActiveGroupId(targetGroupId)
    setEditingKey(`${targetGroupId}:${id}`)
  }

  async function deleteLocalDraft(id: string) {
    if (deletingDraftIds.has(id) || savingDocuments.has(id)) return
    filingDraftIds.current.add(id)
    setDeletingDraftIds((current) => new Set(current).add(id))
    setMessage('')
    try {
      await (draftSyncQueues.current[id] || Promise.resolve()).catch(() => undefined)
      await api<{ deletedId: string }>(`/api/draft?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      setDocuments((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setDrafts((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setGroups((current) => current.map((group) => {
        const tabIndex = group.tabs.indexOf(id)
        const tabs = group.tabs.filter((tabId) => tabId !== id)
        const activeId = group.activeId === id
          ? tabs[Math.min(tabIndex, tabs.length - 1)] || null
          : group.activeId
        return { ...group, tabs, activeId }
      }))
      setEditingKey((current) => current?.endsWith(`:${id}`) ? null : current)
    } catch (error) {
      filingDraftIds.current.delete(id)
      setMessage(error instanceof Error ? error.message : 'Could not delete draft')
    } finally {
      setDeletingDraftIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  async function deleteFiledNote(document: ViewerDocument) {
    if (!document.deletable || isUntitledId(document.id) || deletingNoteId || savingDocuments.has(document.id)) return
    if (!window.confirm(`Delete "${document.title}"? The raw capture will be retained.`)) return

    setDeletingNoteId(document.id)
    setMessage('')
    try {
      await (saveQueues.current[document.id] || Promise.resolve())
      const result = await api<{ deletedId: string; rawId: string | null }>(`/api/note?id=${encodeURIComponent(document.id)}`, {
        method: 'DELETE',
      })
      const [notesResult, filesResult] = await Promise.allSettled([
        api<Note[]>('/api/notes'),
        api<BundleFile[]>('/api/files'),
      ])
      setNotes((current) => notesResult.status === 'fulfilled'
        ? notesResult.value
        : current.filter((note) => note.id !== result.deletedId))
      setFiles((current) => filesResult.status === 'fulfilled'
        ? filesResult.value
        : current.filter((file) => file.id !== result.deletedId))
      setDocuments((current) => {
        const next = { ...current }
        delete next[result.deletedId]
        return next
      })
      setDrafts((current) => {
        const next = { ...current }
        delete next[result.deletedId]
        return next
      })
      setPathDrafts((current) => {
        const next = { ...current }
        delete next[result.deletedId]
        return next
      })
      setTagDrafts((current) => {
        const next = { ...current }
        delete next[result.deletedId]
        return next
      })
      setGroups((current) => current.map((group) => {
        const tabIndex = group.tabs.indexOf(result.deletedId)
        const tabs = group.tabs.filter((id) => id !== result.deletedId)
        const activeId = group.activeId === result.deletedId
          ? tabs[Math.min(tabIndex, tabs.length - 1)] || null
          : group.activeId
        return { ...group, tabs, activeId }
      }))
      setEditingKey((current) => current?.endsWith(`:${result.deletedId}`) ? null : current)
      setSearchResults((current) => current.filter((note) => note.id !== result.deletedId))
      setAnswer(null)
      delete documentRequests.current[result.deletedId]
      for (const key of Object.keys(editorIntents.current)) {
        if (key.endsWith(`:${result.deletedId}`)) delete editorIntents.current[key]
      }
      for (const key of Object.keys(readerScrollPositions.current)) {
        if (key.endsWith(`:${result.deletedId}`)) delete readerScrollPositions.current[key]
      }
      setMessage(`Deleted ${document.title}.${result.rawId ? ' The raw capture was retained.' : ''}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not delete note')
    } finally {
      setDeletingNoteId(null)
    }
  }

  async function openDocument(id: string, source: 'note' | 'file' = 'file', targetGroupId = activeGroupId) {
    const existingGroup = groups.find((group) => group.tabs.includes(id))
    if (existingGroup && existingGroup.id !== targetGroupId) {
      activateTab(existingGroup.id, id)
      return
    }

    setActiveGroupId(targetGroupId)
    setGroups((current) => current.map((group) => group.id === targetGroupId
      ? {
          ...group,
          tabs: group.tabs.includes(id) ? group.tabs : [...group.tabs, id],
          activeId: id,
        }
      : group))

    if (documents[id] || loadingDocuments.has(id)) return
    const requestId = (documentRequests.current[id] || 0) + 1
    documentRequests.current[id] = requestId
    setLoadingDocuments((current) => new Set(current).add(id))
    try {
      const document = source === 'note'
        ? { ...await api<NoteDetail>(`/api/note?id=${encodeURIComponent(id)}`), deletable: true }
        : await api<ViewerDocument>(`/api/file?path=${encodeURIComponent(id)}`)
      if (documentRequests.current[id] !== requestId) return
      setDocuments((current) => ({ ...current, [document.id]: document }))
      if (document.id !== id) {
        setGroups((current) => current.map((group) => ({
          ...group,
          tabs: group.tabs.map((tabId) => tabId === id ? document.id : tabId),
          activeId: group.activeId === id ? document.id : group.activeId,
        })))
      }
    } catch (error) {
      closeTab(targetGroupId, id)
      setMessage(error instanceof Error ? error.message : 'Could not open file')
    } finally {
      setLoadingDocuments((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  function closeTab(groupId: string, documentId: string) {
    setGroups((current) => current.map((group) => {
      if (group.id !== groupId) return group
      const tabIndex = group.tabs.indexOf(documentId)
      const tabs = group.tabs.filter((id) => id !== documentId)
      const activeId = group.activeId === documentId
        ? tabs[Math.min(tabIndex, tabs.length - 1)] || null
        : group.activeId
      return { ...group, tabs, activeId }
    }))
    setEditingKey((current) => current === `${groupId}:${documentId}` ? null : current)
  }

  function splitWorkspace() {
    if (groups.length === 2) return
    const source = groups.find((group) => group.id === activeGroupId) || groups[0]
    const newGroupId = source.id === 'primary' ? 'secondary' : 'primary'
    setGroups((current) => [
      ...current,
      { id: newGroupId, tabs: [], activeId: null },
    ])
    setActiveGroupId(newGroupId)
  }

  function beginHorizontalResize(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('resizing-horizontal')
  }

  function finishHorizontalResize(event: React.PointerEvent<HTMLElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    document.body.classList.remove('resizing-horizontal')
  }

  function resizeSidebar(clientX: number, handle: HTMLElement) {
    const workspace = handle.parentElement
    if (!workspace) return
    const bounds = workspace.getBoundingClientRect()
    const maxWidth = Math.max(220, Math.min(520, bounds.width - 420))
    setSidebarWidth(Math.round(Math.min(maxWidth, Math.max(220, clientX - bounds.left))))
  }

  function resizeSplit(clientX: number, handle: HTMLElement) {
    const workspace = handle.parentElement
    if (!workspace) return
    const bounds = workspace.getBoundingClientRect()
    const availableWidth = bounds.width - handle.offsetWidth
    const minimumPaneWidth = Math.min(280, availableWidth / 2)
    const leftWidth = Math.min(
      availableWidth - minimumPaneWidth,
      Math.max(minimumPaneWidth, clientX - bounds.left),
    )
    setSplitPosition((leftWidth / availableWidth) * 100)
  }

  function closeGroup(groupId: string) {
    if (groups.length === 1) return
    const closing = groups.find((group) => group.id === groupId)
    const remaining = groups.find((group) => group.id !== groupId)
    if (!closing || !remaining) return
    const tabs = [...remaining.tabs, ...closing.tabs.filter((id) => !remaining.tabs.includes(id))]
    setGroups([{ ...remaining, tabs, activeId: remaining.activeId || closing.activeId || tabs[0] || null }])
    setActiveGroupId(remaining.id)
    setEditingKey(null)
  }

  function moveTabToGroup(documentId: string, sourceGroupId: string, targetGroupId: string) {
    if (sourceGroupId === targetGroupId) return
    setGroups((current) => current.map((group) => {
      if (group.id === sourceGroupId) {
        const tabIndex = group.tabs.indexOf(documentId)
        const tabs = group.tabs.filter((id) => id !== documentId)
        return {
          ...group,
          tabs,
          activeId: group.activeId === documentId
            ? tabs[Math.min(tabIndex, tabs.length - 1)] || null
            : group.activeId,
        }
      }
      if (group.id === targetGroupId) {
        return {
          ...group,
          tabs: group.tabs.includes(documentId) ? group.tabs : [...group.tabs, documentId],
          activeId: documentId,
        }
      }
      return group
    }))
    setActiveGroupId(targetGroupId)
    setEditingKey(null)
  }

  function applyUpdatedNote(updated: NoteDetail) {
    setDocuments((current) => ({
      ...current,
      [updated.id]: { ...current[updated.id], ...updated, deletable: true },
    }))
    setNotes((current) => current.map((note) => note.id === updated.id ? { ...note, ...updated } : note))
    setSearchResults((current) => current.map((note) => note.id === updated.id ? {
      ...note,
      ...updated,
      snippet: updated.content.replace(/\s+/g, ' ').trim().slice(0, 320),
    } : note))
    setAnswer((current) => current ? {
      ...current,
      sources: current.sources.map((note) => note.id === updated.id ? { ...note, ...updated } : note),
    } : null)
  }

  function persistDocument(document: ViewerDocument, nextContent: string, nextTags: string[]) {
    if (!document.deletable || !nextContent.trim()) return
    const id = document.id
    const filedContent = isUntitledId(id) ? filedDraftContent(nextContent) : nextContent
    if (!filedContent.trim()) return
    const existingQueue = saveQueues.current[id] || Promise.resolve()
    setDocuments((current) => ({
      ...current,
      [id]: { ...current[id], content: nextContent, tags: nextTags },
    }))
    setSavingDocuments((current) => new Set(current).add(id))

    const save = existingQueue
      .catch(() => undefined)
      .then(async () => {
        if (isUntitledId(id)) {
          filingDraftIds.current.add(id)
          await (draftSyncQueues.current[id] || Promise.resolve()).catch(() => undefined)
          const result = await api<{ note: Note; notes: Note[]; warning: string | null; appended: boolean }>('/api/notes', {
            method: 'POST',
            body: JSON.stringify({
              content: nextContent,
              filedContent,
              draftId: id,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
          })
          const [detailResult, filesResult] = await Promise.allSettled([
            api<NoteDetail>(`/api/note?id=${encodeURIComponent(result.note.id)}`),
            api<BundleFile[]>('/api/files'),
          ])
          const updated: ViewerDocument = detailResult.status === 'fulfilled'
            ? { ...detailResult.value, deletable: true }
            : {
                ...result.note,
                content: filedContent,
                deletable: true,
                movable: true,
                links: [],
                backlinks: [],
                suggestions: [],
              }
          setNotes((current) => [result.note, ...current.filter((note) => note.id !== result.note.id)])
          if (filesResult.status === 'fulfilled') setFiles(filesResult.value)
          setDocuments((current) => {
            const next = { ...current }
            delete next[id]
            next[updated.id] = updated
            return next
          })
          setDrafts((current) => {
            const next = { ...current }
            delete next[id]
            return next
          })
          setGroups((current) => current.map((group) => {
            const tabs = group.tabs
              .map((tabId) => tabId === id ? updated.id : tabId)
              .filter((tabId, index, allTabs) => allTabs.indexOf(tabId) === index)
            return {
              ...group,
              tabs,
              activeId: group.activeId === id ? updated.id : group.activeId,
            }
          }))
          const refreshWarning = detailResult.status === 'rejected' || filesResult.status === 'rejected'
            ? 'The workspace will fully refresh when the file is reopened.'
            : ''
          setMessage([
            result.warning || (result.appended
              ? 'Filed and appended to the existing concept.'
              : 'Filed as a new concept.'),
            refreshWarning,
          ].filter(Boolean).join(' '))
          return
        }
        const { warning, ...updated } = await api<NoteUpdateResult>(`/api/note?id=${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ content: nextContent, tags: nextTags }),
        })
        applyUpdatedNote(updated)
        if (warning) setMessage(warning)
      })
      .catch((error) => {
        if (isUntitledId(id)) filingDraftIds.current.delete(id)
        setMessage(error instanceof Error ? error.message : 'Could not save note')
      })
      .finally(() => {
        if (saveQueues.current[id] === save) {
          delete saveQueues.current[id]
          setSavingDocuments((current) => {
            const next = new Set(current)
            next.delete(id)
            return next
          })
        }
      })
    saveQueues.current[id] = save
  }

  function beginEditing(groupId: string, document: ViewerDocument, intent?: EditorIntent) {
    if (!document.deletable || savingDocuments.has(document.id) || deletingNoteId === document.id) return
    const key = `${groupId}:${document.id}`
    if (intent) editorIntents.current[key] = intent
    setDrafts((current) => ({ ...current, [document.id]: document.content }))
    setEditingKey(key)
  }

  function finishEditing(groupId: string, document: ViewerDocument, scrollTop = 0) {
    const key = `${groupId}:${document.id}`
    if (editingKey !== key) return
    const content = drafts[document.id] ?? document.content
    if (isUntitledId(document.id)) return
    readerScrollPositions.current[key] = scrollTop
    setEditingKey(null)
    if (content !== document.content) persistDocument(document, content, document.tags)
  }

  function fileDraft(document: ViewerDocument) {
    const content = drafts[document.id] ?? document.content
    if (!filedDraftContent(content).trim() || savingDocuments.has(document.id)) return
    filingDraftIds.current.add(document.id)
    setEditingKey(null)
    persistDocument(document, content, [])
  }

  async function toggleTaskCheckbox(document: ViewerDocument, lineNumber: number, checked: boolean) {
    const nextContent = toggleTaskAtLine(document.content, lineNumber, checked)
    if (nextContent) persistDocument(document, nextContent, document.tags)
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
    setSidebarMode('search')
    setSelectedTag(tag)
    setSearchQuery('')
    void searchNotes('', tag)
  }

  async function askNotes() {
    if (!question.trim() || asking) return
    const selectedModel = status?.answerModels.includes(askModel) ? askModel : status?.answerModel
    if (!selectedModel) return
    setAsking(true)
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
      setMessage(error instanceof Error ? error.message : 'Could not ask your notes')
    } finally {
      setAsking(false)
    }
  }

  async function reindexBundle() {
    if (reindexing) return
    setReindexing(true)
    setMessage('')
    try {
      const result = await api<{ notes: Note[]; errors: { id: string; error: string }[] }>('/api/reindex', { method: 'POST' })
      const refreshedFiles = await api<BundleFile[]>('/api/files')
      const openIds = Array.from(new Set(groups.flatMap((group) => group.tabs)))
        .filter((id) => !isUntitledId(id))
      const refreshedDocuments = await Promise.allSettled(openIds.map(async (id) => ({
        oldId: id,
        document: await api<ViewerDocument>(`/api/file?path=${encodeURIComponent(id)}`),
      })))
      const refreshedByOldId = new Map(refreshedDocuments.flatMap((refresh) => refresh.status === 'fulfilled'
        ? [[refresh.value.oldId, refresh.value.document] as const]
        : []))
      setNotes(result.notes)
      setFiles(refreshedFiles)
      setDocuments((current) => {
        const next = { ...current }
        for (const [oldId, document] of refreshedByOldId) {
          if (document.id !== oldId) delete next[oldId]
          next[document.id] = document
        }
        return next
      })
      if ([...refreshedByOldId].some(([oldId, document]) => oldId !== document.id)) {
        setGroups((current) => current.map((group) => ({
          ...group,
          tabs: group.tabs.map((id) => refreshedByOldId.get(id)?.id || id),
          activeId: group.activeId ? refreshedByOldId.get(group.activeId)?.id || group.activeId : null,
        })))
        setEditingKey((current) => {
          if (!current) return current
          const group = groups.find(({ id }) => current.startsWith(`${id}:`))
          if (!group) return current
          const documentId = current.slice(group.id.length + 1)
          const refreshed = refreshedByOldId.get(documentId)
          return refreshed ? `${group.id}:${refreshed.id}` : current
        })
      }
      setSearchResults([])
      setAnswer(null)
      setMessage(result.errors.length
        ? `Reindexed with ${result.errors.length} invalid Markdown file${result.errors.length === 1 ? '' : 's'} skipped.`
        : `Reindexed ${result.notes.length} concepts.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not reindex the bundle')
    } finally {
      setReindexing(false)
    }
  }

  async function moveBundleFile(id: string, directory: string) {
    const file = files.find((item) => item.id === id)
    const isEditing = groups.some((group) => editingKey === `${group.id}:${id}`)
    if (!file?.movable || movingFileId || file.directory === directory || savingDocuments.has(id) || loadingDocuments.has(id) || isEditing) return

    setMovingFileId(id)
    setMessage('')
    try {
      const result = await api<FileMoveResult>('/api/file/move', {
        method: 'POST',
        body: JSON.stringify({ id, directory }),
      })
      const [notesResult, filesResult] = await Promise.allSettled([
        api<Note[]>('/api/notes'),
        api<BundleFile[]>('/api/files'),
      ])

      setDocuments((current) => {
        const next = { ...current }
        delete next[result.oldId]
        next[result.newId] = result.note
        return next
      })
      setGroups((current) => current.map((group) => {
        const tabs = group.tabs
          .map((tabId) => tabId === result.oldId ? result.newId : tabId)
          .filter((tabId, index, allTabs) => allTabs.indexOf(tabId) === index)
        return {
          ...group,
          tabs,
          activeId: group.activeId === result.oldId ? result.newId : group.activeId,
        }
      }))
      setDrafts((current) => {
        if (!(result.oldId in current)) return current
        const next = { ...current }
        delete next[result.oldId]
        next[result.newId] = result.note.content
        return next
      })
      setTagDrafts((current) => {
        if (!(result.oldId in current)) return current
        const next = { ...current }
        delete next[result.oldId]
        next[result.newId] = result.note.tags.join(', ')
        return next
      })
      setPathDrafts((current) => {
        if (!(result.oldId in current)) return current
        const next = { ...current }
        delete next[result.oldId]
        return next
      })
      setNotes(notesResult.status === 'fulfilled'
        ? notesResult.value
        : (current) => current.map((note) => note.id === result.oldId ? { ...note, ...result.note } : note))
      setFiles(filesResult.status === 'fulfilled'
        ? filesResult.value
        : (current) => current.map((item) => item.id === result.oldId ? {
            ...item,
            id: result.newId,
            name: result.newId.split('/').at(-1) || item.name,
            directory,
          } : item))
      setExpandedDirectories((current) => {
        const next = new Set(current).add('/')
        let path = ''
        for (const segment of directory.split('/').filter(Boolean)) {
          path += `/${segment}`
          next.add(path)
        }
        return next
      })
      setSearchResults([])
      setAnswer(null)
      setMessage(result.warning || `Moved note to ${result.newId}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not move note')
    } finally {
      setMovingFileId(null)
      setDraggedFileId(null)
      setDropDirectoryPath(null)
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

  const fileTree = buildFileTree(files)
  const blockedFileIds = new Set([...savingDocuments, ...loadingDocuments])
  for (const group of groups) {
    if (editingKey?.startsWith(`${group.id}:`)) blockedFileIds.add(editingKey.slice(group.id.length + 1))
  }
  const localDraftDocuments = Object.values(documents)
    .filter((document) => isUntitledId(document.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const availableTags = Array.from(new Set(notes.flatMap((note) => note.tags))).sort((left, right) => left.localeCompare(right))
  const configuredAnswerModels = status?.answerModels || []
  const missingModels = status?.missingModels || []
  const modelInstallInProgress = installingModels || Boolean(status?.installingModels.length)
  const selectedAnswerModel = status?.answerModels.includes(askModel) ? askModel : status?.answerModel || ''
  const selectedAnswerModelMissing = Boolean(
    status?.online
    && selectedAnswerModel
    && !hasInstalledModel(selectedAnswerModel, status.installed),
  )
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

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-group">
          <a className="brand" href="#workspace" aria-label="Folio home">
            <span className="brand-mark">F</span>
            <span>Folio</span>
          </a>
          {versionInfo && <span className="app-version">v{versionInfo.version}</span>}
          {versionInfo?.updateAvailable && (
            <a className="update-badge" href={versionInfo.latestUrl} target="_blank" rel="noreferrer">
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
                <div className={`endpoint-status ${endpoint.state}`} key={endpoint.label} title={`${endpoint.label}: ${endpoint.model || 'checking'} (${endpoint.state})`}>
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

      <section
        className="workspace"
        id="workspace"
        style={sidebarWidth === null ? undefined : { '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
      >
        <aside className="workbench-sidebar">
          <nav className="sidebar-tabs" aria-label="Sidebar tools">
            {(['explore', 'search', 'ask'] as SidebarMode[]).map((mode) => (
              <button
                type="button"
                className={sidebarMode === mode ? 'active' : ''}
                onClick={() => setSidebarMode(mode)}
                key={mode}
              >
                {mode}
              </button>
            ))}
          </nav>

          <section className="sidebar-panel">
            {sidebarMode === 'explore' ? (
              <>
                <div className="sidebar-heading">
                  <span>Explorer</span>
                   <button type="button" onClick={reindexBundle} disabled={reindexing} title="Reread Markdown and rebuild search and relationships">
                    {reindexing ? '...' : 'Reindex'}
                  </button>
                </div>
                <div className="tree-scroll">
                  {filesLoading ? (
                    <p className="sidebar-empty">Reading bundle...</p>
                  ) : (
                    <>
                      {localDraftDocuments.length > 0 && (
                        <div className="tree-branch local-drafts">
                          <div className="tree-row tree-directory static" style={{ '--tree-depth': 0 } as React.CSSProperties}>
                            <span className="tree-chevron">v</span>
                            <span className="tree-folder" aria-hidden="true" />
                            <span>Drafts</span>
                            <small>{localDraftDocuments.length}</small>
                          </div>
                          {localDraftDocuments.map((draft) => (
                            <div className="tree-row tree-file draft-tree-row" style={{ '--tree-depth': 1 } as React.CSSProperties} key={draft.id}>
                              <button type="button" className="draft-tree-open" onClick={() => openLocalDraft(draft.id)} title="Local draft">
                                <span className="tree-file-mark">D</span>
                                <span>{draftTitle(drafts[draft.id] ?? draft.content)}</span>
                              </button>
                              <button
                                type="button"
                                className="draft-tree-delete"
                                onClick={() => void deleteLocalDraft(draft.id)}
                                disabled={deletingDraftIds.has(draft.id) || savingDocuments.has(draft.id)}
                                title="Delete draft"
                                aria-label={`Delete ${draftTitle(drafts[draft.id] ?? draft.content)}`}
                              >
                                x
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      <FileTree
                        directory={fileTree}
                        depth={0}
                        expanded={expandedDirectories}
                        draggedFileId={draggedFileId}
                        dropDirectoryPath={dropDirectoryPath}
                        movingFileId={movingFileId}
                        blockedFileIds={blockedFileIds}
                        onToggle={(path) => setExpandedDirectories((current) => {
                          const next = new Set(current)
                          if (next.has(path)) next.delete(path)
                          else next.add(path)
                          return next
                        })}
                        onOpen={(id) => void openDocument(id, 'file')}
                        onFileDragStart={setDraggedFileId}
                        onFileDragEnd={() => { setDraggedFileId(null); setDropDirectoryPath(null) }}
                        onDirectoryDragOver={setDropDirectoryPath}
                        onMove={(id, directory) => void moveBundleFile(id, directory)}
                      />
                    </>
                  )}
                </div>
              </>
            ) : sidebarMode === 'search' ? (
              <>
                <div className="sidebar-heading">
                  <span>Search</span>
                  <small>{status?.embeddingCoverage?.refreshing ? 'Indexing' : `${notes.length} notes`}</small>
                </div>
                <form className="sidebar-form" onSubmit={(event) => { event.preventDefault(); void searchNotes() }}>
                  <input
                    ref={searchInputRef}
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search by meaning"
                    aria-label="Search your notes"
                  />
                  <button type="submit" disabled={(!searchQuery.trim() && !selectedTag) || searching}>
                    {searching ? '...' : 'Go'}
                  </button>
                </form>
                {availableTags.length > 0 && (
                  <div className="sidebar-tags" aria-label="Filter by tag">
                    <button type="button" className={!selectedTag ? 'active' : ''} onClick={() => {
                      setSelectedTag('')
                      if (searchQuery.trim()) void searchNotes(searchQuery, '')
                      else setSearchResults([])
                    }}>All</button>
                    {availableTags.map((tag) => (
                      <button type="button" className={selectedTag === tag ? 'active' : ''} onClick={() => searchTag(tag)} key={tag}>#{tag}</button>
                    ))}
                  </div>
                )}
                <div className="sidebar-results">
                  {searchResults.map((result) => (
                    <button type="button" className="sidebar-result" onClick={() => void openDocument(result.id, 'note')} key={result.id}>
                      <span>{result.type} / {Math.round(result.score * 100)}%</span>
                      <strong>{result.title}</strong>
                      <p>{result.snippet}</p>
                    </button>
                  ))}
                  {!searchResults.length && <p className="sidebar-empty">Search results open as editor tabs.</p>}
                </div>
              </>
            ) : (
              <>
                <div className="sidebar-heading">
                  <span>Ask</span>
                  <select value={selectedAnswerModel} onChange={(event) => { setAskModel(event.target.value); setAnswer(null) }} disabled={asking || !configuredAnswerModels.length} aria-label="Answer model">
                    {configuredAnswerModels.map((model) => (
                      <option key={model} value={model} disabled={Boolean(status?.online && !hasInstalledModel(model, status.installed))}>{model}</option>
                    ))}
                  </select>
                </div>
                <form className="sidebar-ask-form" onSubmit={(event) => { event.preventDefault(); void askNotes() }}>
                  <textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask your notes..." aria-label="Question for your notes" />
                  <button type="submit" disabled={!question.trim() || asking || selectedAnswerModelMissing}>{asking ? 'Thinking...' : 'Ask notes'}</button>
                </form>
                <div className="sidebar-answer">
                  {answer ? (
                    <>
                      <div className="answer-copy">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ href, children }) => href?.startsWith('/') ? (
                              <a href={conceptUrl(href)} onClick={(event) => { event.preventDefault(); void openDocument(href, 'note') }}>{children}</a>
                            ) : <span className="citation">{children}</span>,
                          }}
                        >
                          {answer.answer}
                        </ReactMarkdown>
                      </div>
                      <div className="answer-sources">
                        {answer.sources.map((source) => (
                          <button type="button" onClick={() => void openDocument(source.id, 'note')} key={source.id}>{source.title}</button>
                        ))}
                      </div>
                    </>
                  ) : <p className="sidebar-empty">Answers stay here. Sources open in the editor.</p>}
                </div>
              </>
            )}
          </section>

          <section className="recent-panel">
            <div className="sidebar-heading">
              <span>Recent concepts</span>
              <small>{notes.length}</small>
            </div>
            <div className="recent-list">
              {notes.slice(0, 7).map((note) => (
                <button type="button" className="recent-row" key={note.id} onClick={() => void openDocument(note.id, 'note')}>
                  <span className={`type-pip type-${note.type.toLowerCase().replace(/\s+/g, '-')}`} />
                  <span>
                    <strong>{note.title}</strong>
                    <small>{note.type} / {formatDate(note.createdAt)}</small>
                  </span>
                </button>
              ))}
              {!notes.length && <p className="sidebar-empty">No concepts yet.</p>}
            </div>
          </section>
        </aside>

        <div
          className="horizontal-resize-handle sidebar-resize-handle"
          role="separator"
          tabIndex={0}
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={520}
          aria-valuenow={sidebarWidth ?? undefined}
          onPointerDown={beginHorizontalResize}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeSidebar(event.clientX, event.currentTarget)
          }}
          onPointerUp={finishHorizontalResize}
          onPointerCancel={finishHorizontalResize}
          onDoubleClick={() => setSidebarWidth(null)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const currentWidth = sidebarWidth || event.currentTarget.previousElementSibling?.getBoundingClientRect().width || 310
            const workspaceLeft = event.currentTarget.parentElement?.getBoundingClientRect().left || 0
            resizeSidebar(workspaceLeft + currentWidth + (event.key === 'ArrowLeft' ? -16 : 16), event.currentTarget)
          }}
        />

        <section
          className={`editor-workspace ${groups.length === 2 ? 'is-split' : ''}`}
          style={{ '--split-position': `${splitPosition}%` } as React.CSSProperties}
        >
          {groups.map((group, groupIndex) => {
            const document = group.activeId ? documents[group.activeId] : null
            const isLoading = Boolean(group.activeId && loadingDocuments.has(group.activeId))
            const editKey = document ? `${group.id}:${document.id}` : ''
            const isEditing = editingKey === editKey
            const editorIntent = editorIntents.current[editKey]
            const footerLinks = document
              ? Array.from(new Map(
                  document.links
                    .filter((link) => link.origin === 'frontmatter')
                    .map((link) => [link.id, link]),
                ).values())
                  .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.title.localeCompare(right.title))
                  .slice(0, 6)
              : []
            const frontmatterLinkCount = document
              ? new Set(document.links.filter((link) => link.origin === 'frontmatter').map((link) => link.id)).size
              : 0
            return (
              <Fragment key={group.id}>
                {groupIndex === 1 && (
                  <div
                    className="horizontal-resize-handle split-resize-handle"
                    role="separator"
                    tabIndex={0}
                    aria-label="Resize split notes"
                    aria-orientation="vertical"
                    aria-valuemin={20}
                    aria-valuemax={80}
                    aria-valuenow={Math.round(splitPosition)}
                    onPointerDown={beginHorizontalResize}
                    onPointerMove={(event) => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeSplit(event.clientX, event.currentTarget)
                    }}
                    onPointerUp={finishHorizontalResize}
                    onPointerCancel={finishHorizontalResize}
                    onDoubleClick={() => setSplitPosition(50)}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                      event.preventDefault()
                      const workspace = event.currentTarget.parentElement
                      if (!workspace) return
                      const bounds = workspace.getBoundingClientRect()
                      const availableWidth = bounds.width - event.currentTarget.offsetWidth
                      const nextPosition = splitPosition + (event.key === 'ArrowLeft' ? -2 : 2)
                      resizeSplit(bounds.left + availableWidth * nextPosition / 100, event.currentTarget)
                    }}
                  />
                )}
                <section
                  className={`editor-group ${activeGroupId === group.id ? 'active' : ''} ${dropGroupId === group.id ? 'drop-target' : ''}`}
                  onMouseDown={() => setActiveGroupId(group.id)}
                  onDragOver={(event) => {
                    if (!draggedTab) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setDropGroupId(group.id)
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropGroupId(null)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    const payload = event.dataTransfer.getData('application/x-folio-tab')
                    let tab = draggedTab
                    if (payload) {
                      try {
                        const parsed = JSON.parse(payload) as { documentId?: unknown; groupId?: unknown }
                        if (typeof parsed.documentId === 'string' && typeof parsed.groupId === 'string') {
                          tab = { documentId: parsed.documentId, groupId: parsed.groupId }
                        }
                      } catch {
                        tab = null
                      }
                    }
                    if (tab) moveTabToGroup(tab.documentId, tab.groupId, group.id)
                    setDraggedTab(null)
                    setDropGroupId(null)
                  }}
                >
                <div className="editor-tabs">
                  <div className="tab-strip">
                    {group.tabs.map((id) => (
                      <button
                        type="button"
                        className={`editor-tab ${group.activeId === id ? 'active' : ''}`}
                        onClick={() => activateTab(group.id, id)}
                        draggable
                        onDragStart={(event) => {
                          const payload = { documentId: id, groupId: group.id }
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('application/x-folio-tab', JSON.stringify(payload))
                          setDraggedTab(payload)
                        }}
                        onDragEnd={() => { setDraggedTab(null); setDropGroupId(null) }}
                        title={id}
                        key={id}
                      >
                        <span className="tab-file-mark">{isUntitledId(id) ? '+' : 'M'}</span>
                        <span>{titleForId(id)}</span>
                        {savingDocuments.has(id) && <span className="tab-saving" title="Saving" />}
                        <span
                          className="tab-close"
                          role="button"
                          tabIndex={0}
                          aria-label={`Close ${titleForId(id)}`}
                          onClick={(event) => { event.stopPropagation(); closeTab(group.id, id) }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              event.stopPropagation()
                              closeTab(group.id, id)
                            }
                          }}
                        >x</span>
                      </button>
                    ))}
                  </div>
                  <div className="group-actions">
                    <button type="button" onClick={() => createNewTab(group.id)} title="New note (Cmd+T)" aria-label="New note">+</button>
                    {groups.length === 1 ? (
                      <button type="button" onClick={splitWorkspace} title="Split editor">Split</button>
                    ) : (
                      <button type="button" onClick={() => closeGroup(group.id)} title="Close editor group">Close group</button>
                    )}
                  </div>
                </div>

                <div className="editor-surface">
                  {isLoading ? (
                    <div className="editor-placeholder"><span>Opening file...</span></div>
                  ) : document ? (
                    <article className={`document-view ${isUntitledId(document.id) ? 'untitled' : ''}`}>
                      {!isUntitledId(document.id) && (
                        <header className="document-heading">
                          <p>{document.type}{document.stale ? ' / stale' : ''}</p>
                          <h1>{document.title}</h1>
                          {document.description && <span>{document.description}</span>}
                        </header>
                      )}
                      {isUntitledId(document.id) ? (
                        <NoteEditor
                          key={editKey}
                          value={drafts[document.id] ?? document.content}
                          onChange={(content) => {
                            setDrafts((current) => ({ ...current, [document.id]: content }))
                            setDocuments((current) => ({
                              ...current,
                              [document.id]: {
                                ...current[document.id],
                                content,
                                updatedAt: new Date().toISOString(),
                              },
                            }))
                          }}
                          onBlur={() => undefined}
                          onFile={() => fileDraft(document)}
                          steered
                          ariaLabel="Write a new note"
                        />
                      ) : isEditing ? (
                        <NoteEditor
                          key={editKey}
                          value={drafts[document.id] ?? document.content}
                          onChange={(content) => setDrafts((current) => ({ ...current, [document.id]: content }))}
                          onBlur={(scrollTop) => finishEditing(group.id, document, scrollTop)}
                          intent={editorIntent}
                          ariaLabel={`Edit ${document.title}`}
                        />
                      ) : (
                        <div
                          className={`document-content ${document.deletable ? 'editable' : 'read-only'}`}
                          ref={(element) => {
                            if (!element) return
                            const scrollTop = readerScrollPositions.current[editKey]
                            if (scrollTop === undefined) return
                            element.scrollTop = scrollTop
                            delete readerScrollPositions.current[editKey]
                          }}
                          onClick={(event) => {
                            if ((event.target as Element).closest('a, button, input')) return
                            const source = (event.target as Element).closest<HTMLElement>('[data-source-line]')
                            const startLine = Number(source?.dataset.sourceLine) || 1
                            const endLine = Number(source?.dataset.sourceEndLine) || startLine
                            const lineHeight = source ? Number.parseFloat(window.getComputedStyle(source).lineHeight) || 32 : 32
                            const visualLine = source
                              ? Math.max(0, Math.floor((event.clientY - source.getBoundingClientRect().top) / lineHeight))
                              : 0
                            beginEditing(group.id, document, {
                              lineNumber: Math.min(endLine, startLine + visualLine),
                              scrollTop: event.currentTarget.scrollTop,
                            })
                          }}
                          title={document.deletable ? 'Click to edit' : 'Read-only file'}
                        >
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkBreaks]}
                            components={{
                              a: ({ href, children }) => {
                                const linkedFile = resolveBundleLink(document.id, href)
                                return linkedFile ? (
                                  <a href={conceptUrl(linkedFile)} onClick={(event) => { event.preventDefault(); void openDocument(linkedFile, 'file', group.id) }}>{children}</a>
                                ) : <a href={href}>{children}</a>
                              },
                              p: ({ node, ...props }) => <p {...props} {...sourcePosition(node)} />,
                              h1: ({ node, ...props }) => <h1 {...props} {...sourcePosition(node)} />,
                              h2: ({ node, ...props }) => <h2 {...props} {...sourcePosition(node)} />,
                              h3: ({ node, ...props }) => <h3 {...props} {...sourcePosition(node)} />,
                              h4: ({ node, ...props }) => <h4 {...props} {...sourcePosition(node)} />,
                              h5: ({ node, ...props }) => <h5 {...props} {...sourcePosition(node)} />,
                              h6: ({ node, ...props }) => <h6 {...props} {...sourcePosition(node)} />,
                              blockquote: ({ node, ...props }) => <blockquote {...props} {...sourcePosition(node)} />,
                              pre: ({ node, ...props }) => <pre {...props} {...sourcePosition(node)} />,
                              li: ({ node, ...props }) => <li {...props} {...sourcePosition(node)} />,
                              table: ({ node, ...props }) => <table {...props} {...sourcePosition(node)} />,
                              input: ({ node: _node, ...props }) => (
                                <input
                                  {...props}
                                  disabled={props.type !== 'checkbox' || !document.deletable || savingDocuments.has(document.id)}
                                  onChange={(event) => {
                                    const lineNumber = Number(event.currentTarget.closest('li')?.dataset.sourceLine)
                                    if (lineNumber) void toggleTaskCheckbox(document, lineNumber, event.currentTarget.checked)
                                  }}
                                />
                              ),
                            }}
                          >
                            {document.content}
                          </ReactMarkdown>
                        </div>
                      )}
                      <footer className="document-footer">
                        <div className="document-footer-details">
                          <div className="document-path" title={document.id}>
                            <span>Path</span>
                            {document.movable ? (
                              <input
                                value={pathDrafts[document.id] ?? directoryForId(document.id)}
                                disabled={movingFileId === document.id || savingDocuments.has(document.id) || deletingNoteId === document.id}
                                onFocus={() => setPathDrafts((current) => ({
                                  ...current,
                                  [document.id]: directoryForId(document.id),
                                }))}
                                onChange={(event) => setPathDrafts((current) => ({
                                  ...current,
                                  [document.id]: event.target.value,
                                }))}
                                onBlur={(event) => {
                                  const directory = normalizeDirectoryInput(event.target.value)
                                  setPathDrafts((current) => {
                                    const next = { ...current }
                                    delete next[document.id]
                                    return next
                                  })
                                  if (directory !== directoryForId(document.id)) void moveBundleFile(document.id, directory)
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') event.currentTarget.blur()
                                  if (event.key === 'Escape') {
                                    event.preventDefault()
                                    event.currentTarget.value = directoryForId(document.id)
                                    setPathDrafts((current) => ({
                                      ...current,
                                      [document.id]: directoryForId(document.id),
                                    }))
                                    event.currentTarget.blur()
                                  }
                                }}
                                aria-label={`Path for ${document.title}`}
                              />
                            ) : (
                              <strong>{isUntitledId(document.id) ? 'Unfiled' : document.id}</strong>
                            )}
                          </div>
                          <div className="document-tags">
                            <span>Tags</span>
                            {isUntitledId(document.id) ? (
                              <strong>Assigned when filed</strong>
                            ) : document.deletable ? (
                              <input
                                value={tagDrafts[document.id] ?? document.tags.join(', ')}
                                onFocus={() => setTagDrafts((current) => ({ ...current, [document.id]: document.tags.join(', ') }))}
                                onChange={(event) => setTagDrafts((current) => ({ ...current, [document.id]: event.target.value }))}
                                onBlur={(event) => {
                                  const tags = parseTags(event.target.value)
                                  setTagDrafts((current) => {
                                    const next = { ...current }
                                    delete next[document.id]
                                    return next
                                  })
                                  if (tags.join('\0') !== document.tags.join('\0')) persistDocument(document, document.content, tags)
                                }}
                                aria-label={`Tags for ${document.title}`}
                              />
                            ) : (
                              <strong>{document.tags.length ? document.tags.map((tag) => `#${tag}`).join(' ') : 'None'}</strong>
                            )}
                          </div>
                          <div><span>Status</span><strong>{document.status}</strong></div>
                          <div><span>Last edited</span><strong>{formatDate(document.createdAt)}</strong></div>
                          <div><span>Filing</span><strong>{isUntitledId(document.id) ? 'Pending' : document.filedBy?.startsWith('human:') ? 'Human' : 'Agent'}</strong></div>
                        </div>
                        <div className="save-state">
                          <span>State</span>
                          <div className="save-state-controls">
                            {isUntitledId(document.id) ? (
                              <button type="button" onClick={() => fileDraft(document)} disabled={savingDocuments.has(document.id) || !filedDraftContent(drafts[document.id] || '').trim()} title="Classify and add to the bundle (Cmd+Enter or Cmd+S)">
                                {savingDocuments.has(document.id) ? 'Filing...' : 'File note'}
                              </button>
                            ) : (
                              <>
                                <strong>{savingDocuments.has(document.id) ? 'Saving...' : deletingNoteId === document.id ? 'Deleting...' : document.deletable ? 'Saved' : 'Read only'}</strong>
                                {document.deletable && (
                                  <button
                                    type="button"
                                    className="document-delete"
                                    onClick={() => void deleteFiledNote(document)}
                                    disabled={Boolean(deletingNoteId) || savingDocuments.has(document.id)}
                                    title={`Delete ${document.title}`}
                                  >
                                    Delete
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                        {footerLinks.length > 0 && (
                          <div className="document-footer-links">
                            <span>Links {frontmatterLinkCount}</span>
                            <div className="document-footer-link-list">
                              {footerLinks.map((link) => (
                                <button
                                  type="button"
                                  className="document-footer-link"
                                  onClick={() => void openDocument(link.id, 'file', group.id)}
                                  title={`${link.relation} / ${formatDate(link.createdAt)}`}
                                  key={link.id}
                                >
                                  <strong>{link.title}</strong>
                                  <small>{formatDate(link.createdAt)}</small>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </footer>
                    </article>
                  ) : (
                    <div className="editor-placeholder">
                      <span className="empty-mark">F</span>
                      <h1>Open a note.</h1>
                      <p>Explore the bundle, search by meaning, or ask a question. Every file opens here.</p>
                      <button type="button" className="empty-new-note" onClick={() => createNewTab(group.id)}>New note</button>
                    </div>
                  )}
                </div>
                </section>
              </Fragment>
            )
          })}
          {message && <button type="button" className="workspace-message" onClick={() => setMessage('')} title="Dismiss">{message}</button>}
        </section>
      </section>
    </main>
  )
}

export default App
