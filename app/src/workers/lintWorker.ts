/// <reference lib="webworker" />

import init, { MemoryFileSystem, Workspace } from '@biomejs/wasm-web/biome_wasm.js'

import type { QuickLintDiagnostic, QuickLintResponse } from '../types'

export type LintRequest = {
  id: number
  language: string
  code: string
}

type BiomeContext = {
  workspace: Workspace
  fs: MemoryFileSystem
  projectKey: number
  version: number
  basePath: string
}

let biomeCtxPromise: Promise<BiomeContext> | null = null

self.onmessage = async (event: MessageEvent<LintRequest>) => {
  const request = event.data
  if (!request) return

  if (!supportsLanguage(request.language)) {
    postMessage({
      id: request.id,
      diagnostics: [],
      provider: 'skipped',
      error: `Fast linting is not available for ${request.language}.`,
    } satisfies QuickLintResponse)
    return
  }

  try {
    const diagnostics = await runBiomeLint(request.code, request.language)
    postMessage({ id: request.id, diagnostics, provider: 'biome' } satisfies QuickLintResponse)
  } catch (error) {
    postMessage({
      id: request.id,
      diagnostics: [],
      provider: 'skipped',
      error: error instanceof Error ? error.message : 'Unknown lint error',
    } satisfies QuickLintResponse)
  }
}

async function runBiomeLint(code: string, language: string): Promise<QuickLintDiagnostic[]> {
  const context = await ensureBiome()
  const path = `${context.basePath}/file.${language === 'typescript' ? 'ts' : 'js'}`
  const encoder = new TextEncoder()
  const bytes = encoder.encode(code)

  try {
    context.fs.remove(path)
  } catch {
    // ignore missing file
  }
  context.fs.insert(path, bytes)

  context.workspace.openFile({
    path,
    projectKey: context.projectKey,
    content: {
      type: 'fromClient',
      version: ++context.version,
      content: code,
    },
  })

  const diagnosticsResult = context.workspace.pullDiagnostics({
    projectKey: context.projectKey,
    path,
    categories: ['lint', 'syntax'],
    pullCodeActions: false,
  })

  const lineIndex = buildLineIndex(code)

  return (diagnosticsResult.diagnostics ?? [])
    .filter((diag) => diag.location?.span)
    .map((diag) => {
      const [from, to] = diag.location!.span as [number, number]
      const { line, column } = positionFromOffset(lineIndex, from)
      return {
        from,
        to,
        message: diag.message?.map((node) => node.content).join(' ') || diag.description,
        severity: mapSeverity(diag.severity),
        source: 'biome',
        line,
        column,
      } satisfies QuickLintDiagnostic
    })
}

async function ensureBiome(): Promise<BiomeContext> {
  if (!biomeCtxPromise) {
    biomeCtxPromise = (async () => {
      await init(new URL('@biomejs/wasm-web/biome_wasm_bg.wasm', import.meta.url))
      const fs = new MemoryFileSystem()
      const workspace = Workspace.withFileSystem(fs)
      const { projectKey } = workspace.openProject({ path: 'memory://review', openUninitialized: true })
      workspace.updateSettings({
        projectKey,
        configuration: {
          linter: { enabled: true },
          javascript: { formatter: { enabled: false }, linter: { enabled: true } },
        },
      })
      return {
        workspace,
        fs,
        projectKey,
        version: 1,
        basePath: 'memory://review',
      }
    })()
  }
  return biomeCtxPromise
}

function supportsLanguage(language: string) {
  const normalized = language.toLowerCase()
  return normalized === 'javascript' || normalized === 'typescript'
}

function mapSeverity(severity?: string): 'error' | 'warning' | 'info' {
  switch (severity) {
    case 'fatal':
    case 'error':
      return 'error'
    case 'warning':
      return 'warning'
    default:
      return 'info'
  }
}

function buildLineIndex(code: string) {
  const offsets = [0]
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '\n') {
      offsets.push(i + 1)
    }
  }
  return offsets
}

function positionFromOffset(offsets: number[], target: number) {
  let line = 0
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] > target) {
      line = i - 1
      break
    }
    line = i
  }
  const column = target - offsets[line]
  return { line: line + 1, column: column + 1 }
}
