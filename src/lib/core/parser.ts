import { createHash } from 'node:crypto';

export interface ParsedEvent {
  eventId: string;
  parentId: string | null;
  requestId: string | null;
  sessionId: string;
  timestampMs: number | null;
  type: string;
  subtype: string | null;
  model: string | null;
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  synthetic: boolean;
  refusalOutcome: 'recovered' | 'user_visible' | 'unknown' | null;
  qualityFlags: string | null;
}

type Digest = (value: string) => string;

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Parse only the allowlisted performance metadata needed by the database. Raw
 * content is deliberately never included in the returned object.
 */
export function parseTranscriptEvent(
  rawLine: string,
  sourceId: string,
  lineOffset: number,
  digest: Digest
): ParsedEvent | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawLine) as Record<string, unknown>;
  } catch {
    return null;
  }

  const uuid = typeof raw.uuid === 'string' && raw.uuid ? raw.uuid : null;
  const parentUuid = typeof raw.parentUuid === 'string' && raw.parentUuid ? raw.parentUuid : null;
  const requestId = typeof raw.requestId === 'string' && raw.requestId ? raw.requestId : null;
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null;
  const timestamp = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : Number.NaN;
  const type = typeof raw.type === 'string' ? raw.type : 'unknown';
  const subtype = typeof raw.subtype === 'string' ? raw.subtype : null;
  const message = raw.message && typeof raw.message === 'object' ? (raw.message as Record<string, unknown>) : {};
  const usage =
    message.usage && typeof message.usage === 'object'
      ? (message.usage as Record<string, unknown>)
      : {};
  const occurrenceSeed = `${sourceId}:${lineOffset}:${createHash('sha256').update(rawLine).digest('hex')}`;

  let refusalOutcome: ParsedEvent['refusalOutcome'] = null;
  if (subtype === 'model_refusal_fallback') refusalOutcome = 'recovered';
  else if (subtype === 'model_refusal_no_fallback') refusalOutcome = 'user_visible';
  else if (raw.apiRefusalCategory != null) refusalOutcome = 'unknown';

  return {
    eventId: digest(uuid ? `event:${uuid}` : `occurrence:${occurrenceSeed}`),
    parentId: parentUuid ? digest(`event:${parentUuid}`) : null,
    requestId: requestId ? digest(`request:${requestId}`) : null,
    sessionId: digest(`session:${sessionId ?? sourceId}`),
    timestampMs: Number.isFinite(timestamp) ? timestamp : null,
    type,
    subtype,
    model: typeof message.model === 'string' ? message.model.slice(0, 100) : null,
    outputTokens: safeCount(usage.output_tokens),
    inputTokens: safeCount(usage.input_tokens),
    cacheReadTokens: safeCount(usage.cache_read_input_tokens),
    cacheCreationTokens: safeCount(usage.cache_creation_input_tokens),
    synthetic: raw.isSynthetic === true || raw.isMeta === true && type === 'assistant',
    refusalOutcome,
    qualityFlags: uuid ? null : 'uuid_missing'
  };
}
