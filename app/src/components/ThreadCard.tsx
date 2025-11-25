import { type FormEvent, useState } from 'react'

import type { ReviewThread } from '../types'

interface ThreadCardProps {
  thread: ReviewThread
  onSubmit: (threadId: string, prompt: string) => void
  onHover?: (threadId: string | null) => void
}

export function ThreadCard({ thread, onSubmit, onHover }: ThreadCardProps) {
  const [draft, setDraft] = useState('')
  const isLoading = thread.status === 'loading'

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!draft.trim()) return
    onSubmit(thread.id, draft.trim())
    setDraft('')
  }

  const rangeLabel = `Lines ${thread.range.startLineNumber}–${thread.range.endLineNumber}`

  return (
    <article
      className="thread-card"
      data-loading={isLoading}
      onMouseEnter={() => onHover?.(thread.id)}
      onMouseLeave={() => onHover?.(null)}
      aria-busy={isLoading}
    >
      <header className="thread-card__header">
        <div>
          <p className="thread-card__range">{rangeLabel}</p>
          <p className="thread-card__meta">{thread.language}</p>
        </div>
        <span className="thread-card__timestamp">
          {new Date(thread.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </header>

      <pre className="thread-card__snippet">
        {thread.snippet.trim() || 'The selection was empty.'}
      </pre>

      <div className="thread-card__messages">
        {thread.messages.map((message) => (
          <div key={message.id} className={`thread-card__message thread-card__message--${message.role}`}>
            <span>{message.role === 'assistant' ? 'AI' : 'You'}</span>
            <p>{message.content}</p>
          </div>
        ))}
      </div>

      <form className="thread-card__form" onSubmit={handleSubmit}>
        <textarea
          name="prompt"
          placeholder="Ask a follow-up"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={isLoading}
          aria-label="Thread follow-up prompt"
        />
        <button type="submit" disabled={!draft.trim() || isLoading}>
          Ask AI
        </button>
      </form>

      {thread.error && <p className="thread-card__error">{thread.error}</p>}
    </article>
  )
}
