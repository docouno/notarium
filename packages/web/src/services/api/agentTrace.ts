import { HTTP_STATUS } from '@notarium/contract/http'
import { ApiError, notifyUnauthorized } from './client'

/** Clipboard is an interactive hand-off, not a second large-export transport. */
export const AGENT_TRACE_COPY_MAX_BYTES = 256 * 1024

export type AgentTraceCopyResult =
  { status: 'ready'; text: string; bytes: number } | { status: 'too-large'; limitBytes: number }

const exportUrl = (id: string): string => `/api/me/agent-sessions/${encodeURIComponent(id)}/export`

const responseError = async (response: Response): Promise<ApiError> => {
  const raw = await response.text()
  let message = raw || `HTTP ${response.status}`

  try {
    const body = JSON.parse(raw) as { error?: unknown }

    if (typeof body.error === 'string' && body.error) {
      message = body.error
    }
  } catch {
    // A non-JSON failure still has a useful status/raw message.
  }
  if (response.status === HTTP_STATUS.UNAUTHORIZED) {
    notifyUnauthorized()
  }
  const error = new ApiError(message)
  error.status = response.status
  return error
}

const completeTrace = (text: string): boolean => {
  const last = text.trimEnd().split('\n').at(-1)

  if (!last) {
    return false
  }
  try {
    const value = JSON.parse(last) as { type?: unknown; complete?: unknown }
    return value.type === 'summary' && value.complete === true
  } catch {
    return false
  }
}

export const readAgentTraceForCopy = async (
  response: Response,
  maxBytes = AGENT_TRACE_COPY_MAX_BYTES,
): Promise<AgentTraceCopyResult> => {
  const declared = Number(response.headers.get('content-length'))

  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    return { status: 'too-large', limitBytes: maxBytes }
  }
  if (!response.body) {
    throw new ApiError('Trace export did not return a response body')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''

  for (;;) {
    const chunk = await reader.read()

    if (chunk.done) {
      text += decoder.decode()
      if (!completeTrace(text)) {
        throw new ApiError('Trace export ended before its terminal summary')
      }

      return { status: 'ready', text, bytes }
    }
    bytes += chunk.value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel()
      return { status: 'too-large', limitBytes: maxBytes }
    }
    text += decoder.decode(chunk.value, { stream: true })
  }
}

export const agentTraceApi = {
  agentSessionExportUrl: exportUrl,
  agentSessionTraceCopy: async (
    id: string,
    maxBytes = AGENT_TRACE_COPY_MAX_BYTES,
  ): Promise<AgentTraceCopyResult> => {
    const response = await fetch(exportUrl(id), {
      headers: { Accept: 'application/x-ndjson' },
    })

    if (!response.ok) {
      throw await responseError(response)
    }

    return readAgentTraceForCopy(response, maxBytes)
  },
}
