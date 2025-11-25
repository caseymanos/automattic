import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, type ViewUpdate, Decoration } from '@codemirror/view'
import { type Extension, RangeSetBuilder } from '@codemirror/state'
import { lintGutter, setDiagnostics, type Diagnostic as CMLintDiagnostic } from '@codemirror/lint'
import { nanoid } from 'nanoid'

import './App.css'
import { ThreadCard } from './components/ThreadCard'
import { requestReview } from './lib/aiClient'
import type { QuickLintResponse, ReviewThread, SelectionRange, ThreadMessage } from './types'

const DEFAULT_CODE = `import cache from './cache'

export async function fetchLatestPosts(client, { limit = 20, status = 'draft' } = {}) {
  const cacheKey = ['posts', status, limit].join(':')
  const cached = cache.read(cacheKey)
  if (cached) {
    return cached
  }

  const response = await client.fetch(
    '/wp-json/wp/v2/posts?' + new URLSearchParams({ per_page: String(limit), status }),
  )

  if (!response.ok) {
    throw new Error('Network failure while loading posts')
  }

  const posts = await response.json()
  const normalized = posts.map((post) => ({
    id: post.id,
    title: post.title?.rendered ?? '(untitled)',
    author: post._embedded?.author?.[0]?.name ?? 'Unknown',
    updatedAt: post.modified_gmt,
    isDraft: post.status === 'draft',
  }))

  cache.write(cacheKey, normalized, { ttl: 60 * 5 })
  return normalized
}

export async function hydrateEditorView(view, posts) {
  const errors = []
  for (const post of posts) {
    try {
      await view.addBlock(post.blocks)
    } catch (error) {
      errors.push({ id: post.id, message: error.message })
    }
  }

  if (errors.length > 0) {
    console.warn('Some blocks failed to hydrate', errors)
  }
}

export function scheduleAutoSave(editor, { intervalMs = 15000 } = {}) {
  if (!editor) {
    throw new Error('editor instance required')
  }

  let timer = null
  const runSave = async () => {
    const dirtyBlocks = editor.getDirtyBlocks()
    if (dirtyBlocks.length === 0) {
      return
    }
    await editor.saveBlocks(dirtyBlocks)
  }

  timer = setInterval(runSave, intervalMs)
  return () => clearTimeout(timer)
}

async function refreshDashboardWidgets(widgets, client) {
  const active = widgets.filter((widget) => widget.enabled)
  const results = []

  for (const widget of active) {
    if (widget.requiresNetwork) {
      const response = await client.get(widget.endpoint)
      const data = await response.json()
      results.push({ id: widget.id, data })
    } else {
      const data = widget.compute(client)
      results.push({ id: widget.id, data })
    }
  }

  return results
}
`

const LANGUAGES = ['javascript', 'typescript', 'python', 'php', 'markdown'] as const

type LanguageOption = (typeof LANGUAGES)[number]

const LANGUAGE_LOADERS: Record<LanguageOption, () => Promise<Extension[]>> = {
  javascript: async () => {
    const mod = await import('@codemirror/lang-javascript')
    return [mod.javascript({ jsx: true })]
  },
  typescript: async () => {
    const mod = await import('@codemirror/lang-javascript')
    return [mod.javascript({ jsx: true, typescript: true })]
  },
  python: async () => {
    const mod = await import('@codemirror/lang-python')
    return [mod.python()]
  },
  php: async () => {
    const mod = await import('@codemirror/lang-php')
    return [mod.php()]
  },
  markdown: async () => {
    const mod = await import('@codemirror/lang-markdown')
    return [mod.markdown()]
  },
}

const createThreadHighlightExtension = (threads: ReviewThread[], hoveredId: string | null): Extension => {
  return EditorView.decorations.of((view) => {
    const builder = new RangeSetBuilder<Decoration>()
    const doc = view.state.doc

    threads.forEach((thread) => {
      if (doc.lines === 0) return

      const startLineNumber = Math.min(thread.range.startLineNumber, doc.lines)
      const endLineNumber = Math.min(thread.range.endLineNumber, doc.lines)
      const className = thread.id === hoveredId ? 'cm-thread-highlight-active' : 'cm-thread-highlight'

      for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber++) {
        const line = doc.line(lineNumber)
        builder.add(line.from, line.from, Decoration.line({ class: className }))
      }
    })

    return builder.finish()
  })
}

const maxPreviewLines = 5

function App() {
  const [code, setCode] = useState(DEFAULT_CODE)
  const [language, setLanguage] = useState<LanguageOption>('javascript')
  const [threads, setThreads] = useState<ReviewThread[]>([])
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null)
  const [selection, setSelection] = useState<{
    range: SelectionRange
    snippet: string
  } | null>(null)
  const [prompt, setPrompt] = useState('')
  const [languageExtensions, setLanguageExtensions] = useState<Extension[]>([])
  const languageExtensionCache = useRef<Partial<Record<LanguageOption, Extension[]>>>({})
  const editorViewRef = useRef<EditorView | null>(null)
  const lintWorkerRef = useRef<Worker | null>(null)
  const lintRequestIdRef = useRef(0)
  const lintLatestResponseRef = useRef(0)
  const lintDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lintDiagnosticsRef = useRef<CMLintDiagnostic[]>([])
  const [lintMeta, setLintMeta] = useState<{ status: 'idle' | 'running' | 'ready' | 'skipped'; count: number; error?: string }>(
    { status: 'idle', count: 0 },
  )

  const selectionPreview = useMemo(() => {
    if (!selection) return ''
    return selection.snippet
      .split('\n')
      .slice(0, maxPreviewLines)
      .join('\n')
  }, [selection])

  const lintStatusText = useMemo(() => {
    if (lintMeta.status === 'running') return 'Running checks…'
    if (lintMeta.status === 'ready') {
      return lintMeta.count === 0 ? 'No issues detected' : `${lintMeta.count} quick issue${lintMeta.count === 1 ? '' : 's'}`
    }
    if (lintMeta.status === 'skipped') return 'Lint not available for this language'
    return 'Idle'
  }, [lintMeta])

  useEffect(() => {
    let cancelled = false
    const cached = languageExtensionCache.current[language]

    if (cached) {
      setLanguageExtensions(cached)
      return () => {
        cancelled = true
      }
    }

    setLanguageExtensions([])

    LANGUAGE_LOADERS[language]()
      .then((extension) => {
        if (cancelled) return
        languageExtensionCache.current[language] = extension
        setLanguageExtensions(extension)
      })
      .catch(() => {
        if (!cancelled) setLanguageExtensions([])
      })

    return () => {
      cancelled = true
    }
  }, [language])

  useEffect(() => {
    const worker = new Worker(new URL('./workers/lintWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<QuickLintResponse>) => {
      const data = event.data
      if (!data) return
      if (data.id < lintLatestResponseRef.current) return
      lintLatestResponseRef.current = data.id

      const diagnostics: CMLintDiagnostic[] = data.diagnostics.map((diag) => ({
        from: diag.from,
        to: diag.to,
        message: diag.message,
        severity: diag.severity,
      }))

      lintDiagnosticsRef.current = diagnostics
      if (editorViewRef.current) {
        editorViewRef.current.dispatch(
          setDiagnostics(editorViewRef.current.state, diagnostics),
        )
      }

      setLintMeta({
        status: data.provider === 'biome' ? 'ready' : 'skipped',
        count: data.diagnostics.length,
        error: data.error,
      })
    }
    lintWorkerRef.current = worker
    return () => worker.terminate()
  }, [])

  useEffect(() => {
    if (!lintWorkerRef.current) return

    setLintMeta({ status: 'running', count: 0 })

    if (lintDebounceRef.current) {
      clearTimeout(lintDebounceRef.current)
    }

    lintDebounceRef.current = window.setTimeout(() => {
      const id = ++lintRequestIdRef.current
      lintWorkerRef.current?.postMessage({ id, language, code })
    }, 250)

    return () => {
      if (lintDebounceRef.current) {
        clearTimeout(lintDebounceRef.current)
        lintDebounceRef.current = null
      }
    }
  }, [code, language])

  const handleEditorUpdate = useCallback((viewUpdate: ViewUpdate) => {
    editorViewRef.current = viewUpdate.view
    if (!viewUpdate.selectionSet && !viewUpdate.docChanged) {
      return
    }

    const selectionRange = viewUpdate.state.selection.main
    if (selectionRange.empty) {
      setSelection(null)
      return
    }

    const snippet = viewUpdate.state.doc.sliceString(selectionRange.from, selectionRange.to)
    if (!snippet.trim()) {
      setSelection(null)
      return
    }

    const startLine = viewUpdate.state.doc.lineAt(selectionRange.from)
    const endLine = viewUpdate.state.doc.lineAt(selectionRange.to)

    const range: SelectionRange = {
      startLineNumber: startLine.number,
      startColumn: selectionRange.from - startLine.from + 1,
      endLineNumber: endLine.number,
      endColumn: selectionRange.to - endLine.from + 1,
    }

    setSelection({ range, snippet })
  }, [])

  const createMessage = (role: ThreadMessage['role'], content: string): ThreadMessage => ({
    id: nanoid(),
    role,
    content,
    createdAt: new Date().toISOString(),
  })

  const updateThreadById = (threadId: string, updater: (thread: ReviewThread) => ReviewThread) => {
    setThreads((prev) => prev.map((thread) => (thread.id === threadId ? updater(thread) : thread)))
  }

  const streamAssistantResponse = async (threadSnapshot: ReviewThread) => {
    const assistantMessage = createMessage('assistant', '')
    updateThreadById(threadSnapshot.id, (thread) => ({
      ...thread,
      messages: [...thread.messages, assistantMessage],
      status: 'loading',
      error: undefined,
    }))

    const updateAssistantContent = (updater: (current: string) => string) => {
      updateThreadById(threadSnapshot.id, (thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === assistantMessage.id ? { ...message, content: updater(message.content) } : message,
        ),
      }))
    }

    try {
      let streamedContent = ''
      const response = await requestReview(
        {
          prompt: threadSnapshot.messages.at(-1)?.content ?? '',
          code,
          language: threadSnapshot.language,
          selectionText: threadSnapshot.snippet,
          selectionRange: threadSnapshot.range,
          history: threadSnapshot.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        },
        {
          onChunk: (chunk) => {
            streamedContent += chunk
            updateAssistantContent((current) => current + chunk)
          },
        },
      )

      const finalContent = response.content || streamedContent
      updateAssistantContent(() => finalContent)
      updateThreadById(threadSnapshot.id, (thread) => ({ ...thread, status: 'idle', error: undefined }))
    } catch (error) {
      updateThreadById(threadSnapshot.id, (thread) => ({
        ...thread,
        status: 'error',
        error: error instanceof Error ? error.message : 'Something went wrong',
        messages: thread.messages.filter((message) => message.id !== assistantMessage.id),
      }))
    }
  }

  const handleCreateThread = async () => {
    if (!selection || !prompt.trim()) return

    const userMessage = createMessage('user', prompt.trim())
    const newThread: ReviewThread = {
      id: nanoid(),
      language,
      snippet: selection.snippet,
      range: selection.range,
      messages: [userMessage],
      status: 'loading',
      createdAt: new Date().toISOString(),
    }

    setThreads((prev) => [...prev, newThread])
    setPrompt('')
    setSelection(null)

    void streamAssistantResponse(newThread)
  }

  const handleFollowUp = async (threadId: string, promptText: string) => {
    let snapshot: ReviewThread | null = null

    setThreads((prev) =>
      prev.map((thread) => {
        if (thread.id !== threadId) return thread
        snapshot = {
          ...thread,
          messages: [...thread.messages, createMessage('user', promptText)],
          status: 'loading',
          error: undefined,
        }
        return snapshot
      }),
    )

    if (snapshot) {
      void streamAssistantResponse(snapshot)
    }
  }

  const codeMirrorExtensions = useMemo<Extension[]>(() => {
    return [
      EditorView.lineWrapping,
      lintGutter(),
      ...languageExtensions,
      createThreadHighlightExtension(threads, hoveredThreadId),
    ]
  }, [languageExtensions, threads, hoveredThreadId])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Inline AI review</p>
          <h1>Code Review Assistant</h1>
          <p className="subtitle">
            Highlight code, ask focused questions, and keep threaded conversations anchored to each block.
          </p>
        </div>
        <div className="language-select">
          <label htmlFor="language">Language</label>
          <select
            id="language"
            value={language}
            onChange={(event) => setLanguage(event.target.value as (typeof LANGUAGES)[number])}
          >
            {LANGUAGES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </header>

      {selection && (
        <div className="selection-banner">
          <div>
            <p className="selection-label">
              Lines {selection.range.startLineNumber}–{selection.range.endLineNumber}
            </p>
            <pre>{selectionPreview}</pre>
          </div>
          <div className="selection-actions">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="What feedback do you need for this block?"
              aria-label="Prompt for selected code block"
            />
            <button type="button" onClick={handleCreateThread} disabled={!prompt.trim()}>
              Ask AI
            </button>
          </div>
        </div>
      )}

      <div className="lint-status" aria-live="polite">
        <div>
          <p className="lint-status__label">Quick lint (WASM)</p>
          <p className="lint-status__value">{lintStatusText}</p>
        </div>
        {lintMeta.error && <p className="lint-status__error">{lintMeta.error}</p>}
      </div>

      <section className="workspace">
        <div className="editor-panel">
          <CodeMirror
            value={code}
            height="100%"
            theme={oneDark}
            extensions={codeMirrorExtensions}
            onChange={(value) => setCode(value)}
            onUpdate={handleEditorUpdate}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: false,
              foldGutter: false,
            }}
          />
        </div>

        <aside className="threads-panel">
          <div className="threads-header">
            <h2>Threads</h2>
            <p>{threads.length} active</p>
          </div>
          {threads.length === 0 ? (
            <p className="empty-state">Select a block in the editor to start a conversation.</p>
          ) : (
            <div className="thread-list">
              {threads.map((thread) => (
                <ThreadCard
                  key={thread.id}
                  thread={thread}
                  onSubmit={handleFollowUp}
                  onHover={(id) => setHoveredThreadId(id)}
                />
              ))}
            </div>
          )}
        </aside>
      </section>
    </div>
  )
}

export default App
