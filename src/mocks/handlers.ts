import { http, HttpResponse } from 'msw'
import { analyzeDocument } from '@/lib/markdown'
import { analyzeMigration } from '@/lib/migration'
import { seedConflicts, seedDocument, seedHistory } from '@/lib/seed'
import type { Discussion, GlossaryTerm, HistoryEntry, Segment, TranslationConflict } from '@/lib/types'

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const handlers = [
  http.get('/api/document', () => HttpResponse.json(clone(seedDocument))),
  http.get('/api/history', () => HttpResponse.json(clone(seedHistory))),
  http.get('/api/conflicts', () => HttpResponse.json(clone(seedConflicts))),
  http.post('/api/check', async ({ request }) => {
    const body = await request.json() as { segments: Segment[]; glossary: GlossaryTerm[] }
    await new Promise((resolve) => setTimeout(resolve, 320))
    return HttpResponse.json({ checkedAt: Date.now(), issues: analyzeDocument(body.segments, body.glossary) })
  }),
  http.post('/api/draft', async ({ request }) => {
    const body = await request.json() as { documentId: string; segments: Segment[]; discussions: unknown[] }
    await new Promise((resolve) => setTimeout(resolve, 240))
    return HttpResponse.json({ saved: true, documentId: body.documentId, segmentCount: body.segments.length, savedAt: Date.now() })
  }),
  http.post('/api/review', async ({ request }) => {
    const body = await request.json() as { action: string; segmentIds: string[]; reason?: string }
    await new Promise((resolve) => setTimeout(resolve, 280))
    return HttpResponse.json({ accepted: true, ...body, reviewedAt: Date.now() })
  }),
  http.post('/api/migration/analyze', async ({ request }) => {
    const body = await request.json() as { segments: Segment[]; markdown: string; fileName: string; discussions: Discussion[]; history: HistoryEntry[]; conflicts: TranslationConflict[] }
    await new Promise((resolve) => setTimeout(resolve, 420))
    const plan = analyzeMigration(body.segments, body.markdown, body.fileName, body.discussions, body.history, body.conflicts)
    return HttpResponse.json({ plan })
  }),
]
