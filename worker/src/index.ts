import { streamText, type CoreMessage, type LanguageModelV1 } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'

interface Env {
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  OPENAI_MODEL?: string
  ANTHROPIC_MODEL?: string
  OPENROUTER_API_KEY?: string
  OPENROUTER_MODEL?: string
  OPENROUTER_SITE_URL?: string
  OPENROUTER_APP_NAME?: string
  OPENROUTER_BASE_URL?: string
}

interface SelectionRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

interface ReviewPayload {
  prompt?: string
  code: string
  language: string
  selectionText: string
  selectionRange: SelectionRange
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

const SYSTEM_PROMPT = `You are an expert WordPress, Gutenberg, and PHP reviewer.
Focus on clarity, performance, security, and editor ergonomics.
Return actionable feedback grouped by theme, point out blockers vs. nits, and propose concrete code-level improvements.`

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
}

type ModelSelection = {
  name: string
  provider: 'openai' | 'anthropic' | 'openrouter'
  variant: 'fast' | 'deep'
  model: LanguageModelV1
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS })
    }

    let payload: ReviewPayload
    try {
      payload = (await request.json()) as ReviewPayload
    } catch (error) {
      return jsonResponse({ error: 'Invalid JSON payload' }, 400)
    }

    if (!payload?.code || !payload.selectionRange) {
      return jsonResponse({ error: 'Missing code or selection metadata' }, 400)
    }

    try {
      const selection = selectModel(payload, env)
      const messages = buildMessages(payload)

      const result = await streamText({
        model: selection.model,
        messages,
        maxTokens: 900,
        temperature: selection.variant === 'fast' ? 0.15 : 0.2,
        topP: 0.9,
      })

      return result.toTextStreamResponse({
        headers: {
          ...CORS_HEADERS,
          'x-ai-provider': selection.provider,
          'x-ai-model': selection.name,
        },
      })
    } catch (error) {
      console.error('AI worker error', error)
      return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, 500)
    }
  },
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function selectModel(payload: ReviewPayload, env: Env): ModelSelection {
  const openaiKey = env.OPENAI_API_KEY?.trim()
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim()

  const openRouterKey = env.OPENROUTER_API_KEY?.trim()

  if (!openaiKey && !anthropicKey && !openRouterKey) {
    throw new Error('AI credentials missing. Provide OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY.')
  }

  const openai = openaiKey ? createOpenAI({ apiKey: openaiKey }) : null
  const anthropic = anthropicKey ? createAnthropic({ apiKey: anthropicKey }) : null
  const openrouter = openRouterKey
    ? createOpenAI({
        apiKey: openRouterKey,
        baseURL: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
        headers: {
          'HTTP-Referer': env.OPENROUTER_SITE_URL || 'https://inline-review.local',
          'X-Title': env.OPENROUTER_APP_NAME || 'Inline Code Review Assistant',
        },
      })
    : null

  const fastPath = payload.selectionText.length < 600 && (payload.history?.length ?? 0) < 2

  if (fastPath && openai) {
    const name = env.OPENAI_MODEL || 'o4-mini'
    return {
      name,
      provider: 'openai',
      variant: 'fast',
      model: openai(name),
    }
  }

  if (fastPath && openrouter) {
    const name = env.OPENROUTER_MODEL || 'openrouter/meta-llama-3.1-70b-instruct'
    return {
      name,
      provider: 'openrouter',
      variant: 'fast',
      model: openrouter(name),
    }
  }

  if (anthropic) {
    const name = env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest'
    return {
      name,
      provider: 'anthropic',
      variant: 'deep',
      model: anthropic(name),
    }
  }

  if (openrouter) {
    const name = env.OPENROUTER_MODEL || 'openrouter/meta-llama-3.1-70b-instruct'
    return {
      name,
      provider: 'openrouter',
      variant: 'deep',
      model: openrouter(name),
    }
  }

  if (openai) {
    const name = env.OPENAI_MODEL || 'o4-mini'
    return {
      name,
      provider: 'openai',
      variant: 'deep',
      model: openai(name),
    }
  }

  throw new Error('No AI provider configured')
}

function buildMessages(payload: ReviewPayload): CoreMessage[] {
  const history = payload.history ?? []
  const prior = history.slice(0, -1).map((message) => ({
    role: message.role,
    content: message.content,
  }))
  const latestUser = history[history.length - 1]
  const enrichedUserPrompt = formatUserPrompt(payload, latestUser?.content ?? payload.prompt ?? '')

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...prior,
    { role: 'user', content: enrichedUserPrompt },
  ] as CoreMessage[]
}

function formatUserPrompt(payload: ReviewPayload, latestPrompt: string): string {
  const trimmedSelection = payload.selectionText.trim() || '(selection was empty)'
  const surround = extractContext(payload.code, payload.selectionRange, 8)
  const rangeLabel = `lines ${payload.selectionRange.startLineNumber}-${payload.selectionRange.endLineNumber}`

  return [
    `Primary question: ${latestPrompt || 'Provide a detailed review focused on readability, safety, and WP best practices.'}`,
    `Language: ${payload.language}`,
    `Selected ${rangeLabel}:\n\n\`\`\`${inferFence(payload.language)}\n${trimmedSelection}\n\`\`\``,
    `Nearby context:\n\n\`\`\`${inferFence(payload.language)}\n${surround}\n\`\`\``,
    `Please respond with:
1. High-level summary (2 bullet points max)
2. Detailed findings grouped by category (correctness, performance, accessibility, WP/editor UX)
3. Specific code suggestions with snippets when applicable
4. Quick wins that can be auto-fixed`,
  ].join('\n\n')
}

function extractContext(code: string, range: SelectionRange, radius: number) {
  const lines = code.split(/\r?\n/)
  const start = Math.max(0, range.startLineNumber - 1 - radius)
  const end = Math.min(lines.length, range.endLineNumber + radius)
  return lines.slice(start, end).join('\n')
}

function inferFence(language: string) {
  const normalized = language.toLowerCase()
  if (normalized.includes('php')) return 'php'
  if (normalized.includes('python')) return 'python'
  if (normalized.includes('ts')) return 'ts'
  if (normalized.includes('js')) return 'javascript'
  return ''
}
