export type MessageRole = 'user' | 'assistant'

export interface ThreadMessage {
  id: string
  role: MessageRole
  content: string
  createdAt: string
}

export interface SelectionRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export type ThreadStatus = 'idle' | 'loading' | 'error'

export interface ReviewThread {
  id: string
  language: string
  snippet: string
  range: SelectionRange
  messages: ThreadMessage[]
  status: ThreadStatus
  createdAt: string
  error?: string
}

export interface QuickLintDiagnostic {
  from: number
  to: number
  message: string
  severity: 'error' | 'warning' | 'info'
  source: 'biome'
  line: number
  column: number
}

export interface QuickLintResponse {
  id: number
  diagnostics: QuickLintDiagnostic[]
  provider: 'biome' | 'skipped'
  error?: string
}
