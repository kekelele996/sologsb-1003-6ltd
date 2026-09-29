export type SegmentKind = 'heading' | 'paragraph' | 'code' | 'link' | 'variable'
export type SegmentStatus = 'draft' | 'needs-work' | 'confirmed' | 'returned' | 'needs-review'
export type IssueType = 'missing-translation' | 'missing-variable' | 'link-mismatch' | 'glossary' | 'code-format'
export type IssueSeverity = 'error' | 'warning'

export interface Segment {
  id: string
  index: number
  kind: SegmentKind
  sourceText: string
  targetText: string
  status: SegmentStatus
  protectedTokens: string[]
  note: string
  migratedFrom?: string
  migratedMatch?: MigrationMatchKind
}

export interface GlossaryTerm {
  id: string
  source: string
  target: string
  caseSensitive: boolean
  note: string
}

export interface Discussion {
  id: string
  segmentId: string
  author: string
  body: string
  resolved: boolean
  createdAt: number
}

export interface TranslationIssue {
  id: string
  segmentId: string
  type: IssueType
  severity: IssueSeverity
  message: string
  expected?: string
}

export interface HistoryEntry {
  id: string
  segmentId: string
  author: string
  action: 'edit' | 'confirm' | 'return' | 'resolve-conflict' | 'import' | 'discussion' | 'migrate'
  before: string
  after: string
  createdAt: number
}

export interface TranslationConflict {
  id: string
  segmentId: string
  localText: string
  remoteText: string
  remoteAuthor: string
  createdAt: number
}

export interface LocalizationDocument {
  id: string
  title: string
  sourceFile: string
  sourceLanguage: string
  targetLanguage: string
  updatedAt: number
  segments: Segment[]
  glossary: GlossaryTerm[]
  discussions: Discussion[]
}

export type MigrationMatchKind =
  | 'exact'
  | 'moved'
  | 'similar'
  | 'split'
  | 'merge'
  | 'duplicate'
  | 'new'
  | 'removed'
  | 'manual'

export interface MigrationMatch {
  id: string
  kind: MigrationMatchKind
  oldSegmentIds: string[]
  newSegmentIds: string[]
  similarity?: number
}

export type MigrationPendingKind = 'duplicate' | 'split' | 'merge'

export interface MigrationPending {
  id: string
  kind: MigrationPendingKind
  oldSegmentIds: string[]
  newSegmentIds: string[]
  note: string
}

export interface ArchivedSegment {
  segment: Segment
  discussions: Discussion[]
  history: HistoryEntry[]
  conflicts: TranslationConflict[]
  archivedAt: number
}

export interface MigrationSession {
  id: string
  createdAt: number
  updatedAt: number
  sourceFile: string
  oldSegments: Segment[]
  newSegments: Segment[]
  matches: MigrationMatch[]
  pending: MigrationPending[]
  archived: ArchivedSegment[]
  appliedAt?: number
}
