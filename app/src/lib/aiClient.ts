import { nanoid } from 'nanoid'

import type { SelectionRange } from '../types'

export interface ReviewPayload {
  prompt: string
  code: string
  language: string
  selectionText: string
  selectionRange: SelectionRange
  history: Array<{
    role: 'user' | 'assistant'
    content: string
  }>
}

export interface ReviewResponse {
  id: string
  content: string
  provider?: string | null
  model?: string | null
}

export interface ReviewRequestOptions {
  onChunk?: (chunk: string) => void
}

export async function requestReview(
  payload: ReviewPayload,
  options?: ReviewRequestOptions,
): Promise<ReviewResponse> {
  const endpoint = import.meta.env.VITE_AI_ENDPOINT

  if (endpoint) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok || !response.body) {
      throw new Error('AI provider rejected the request')
    }

    const provider = response.headers.get('x-ai-provider')
    const model = response.headers.get('x-ai-model')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let content = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        content += decoder.decode()
        break
      }
      if (value) {
        const chunk = decoder.decode(value, { stream: true })
        if (chunk) {
          content += chunk
          options?.onChunk?.(chunk)
        }
      }
    }

    const normalized = content.trim()
    if (!normalized) {
      throw new Error('AI provider returned an empty response')
    }

    return {
      id: nanoid(),
      content: normalized,
      provider,
      model,
    }
  }

  const mock = buildMockResponse(payload)
  options?.onChunk?.(mock.content)
  return Promise.resolve(mock)
}

function buildMockResponse(payload: ReviewPayload): ReviewResponse {
  const lines = payload.selectionText.split('\n')
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
  const distinctLineCount = new Set(nonEmptyLines.map((line) => line.trim())).size

  const insights: string[] = []

  if (payload.selectionText.length > 240) {
    insights.push('Break the block into smaller functions to keep each unit focused.')
  }

  if (/console\.log/.test(payload.selectionText)) {
    insights.push('Remove debugging console logs or guard them behind a verbose flag.')
  }

  if (/todo/i.test(payload.selectionText)) {
    insights.push('Resolve the TODO items before shipping to avoid accidental regressions.')
  }

  if (/await/.test(payload.selectionText) && !/try\s*{/.test(payload.selectionText)) {
    insights.push('Wrap awaited operations with error handling to surface failures clearly.')
  }

  if (distinctLineCount < nonEmptyLines.length / 2) {
    insights.push('Consider deduplicating repeated logic or extracting helper utilities.')
  }

  if (insights.length === 0) {
    insights.push('The logic looks consistent; focus on naming clarity and inline documentation for tricky sections.')
  }

  const summary = nonEmptyLines.slice(0, 4).join('\n')

  const content = `### Contextual feedback (mock)\n` +
    `Language: **${payload.language}** | Lines ${payload.selectionRange.startLineNumber}-${payload.selectionRange.endLineNumber}\n\n` +
    `${payload.prompt ? `**Prompt:** ${payload.prompt}\n\n` : ''}` +
    `**Highlights from selection**\n\n\`\`\`\n${summary || '(selection was empty)'}\n\`\`\`\n\n` +
    `**Suggestions**\n` + insights.map((tip, index) => `${index + 1}. ${tip}`).join('\n') +
    `\n\nFeel free to iterate on this block and ask more follow-ups.`

  return {
    id: nanoid(),
    content,
  }
}
