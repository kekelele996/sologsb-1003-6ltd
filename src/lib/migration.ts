import { extractProtected } from './markdown'
import type {
  ArchivedSegment,
  Discussion,
  HistoryEntry,
  MigrationMatch,
  MigrationMatchKind,
  MigrationPending,
  MigrationSession,
  Segment,
  TranslationConflict,
} from './types'

export const MIGRATION_STORAGE_KEY = 'sologsb-1003-migration-session-v1'

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** 折叠空白与 Markdown 标记，用于模糊比较。精确匹配仍使用原始文本。 */
export const normalizeSource = (text: string) =>
  text
    .toLowerCase()
    .replace(/[#>*_`~\-[\]()!{}%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[b.length]
}

/** 相似度：编辑距离比率与字符二元组 Dice 系数各占一半，对中英文轻改都较稳。 */
export const similarity = (a: string, b: string): number => {
  const left = normalizeSource(a)
  const right = normalizeSource(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const distanceRatio = 1 - levenshtein(left, right) / Math.max(left.length, right.length)
  const bigrams = (text: string) => {
    const set = new Set<string>()
    for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2))
    return set
  }
  const leftGrams = bigrams(left)
  const rightGrams = bigrams(right)
  let overlap = 0
  leftGrams.forEach((gram) => { if (rightGrams.has(gram)) overlap += 1 })
  const dice = leftGrams.size + rightGrams.size ? (2 * overlap) / (leftGrams.size + rightGrams.size) : 0
  return Math.max(0, (distanceRatio + dice) / 2)
}

/** 拆分为英文单词与单个 CJK 字符，作为拆分/合并覆盖度计算的词元集。常见停用词不计入。 */
const stopWords = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'to', 'of', 'in', 'on', 'for', 'at', 'by',
  'with', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'as', 'you', 'your',
])
const tokenSet = (text: string) => {
  const normalized = normalizeSource(text)
  const tokens = new Set<string>()
  const wordMatches = normalized.match(/[a-z0-9]+/g) ?? []
  wordMatches.forEach((word) => { if (word.length > 1 && !stopWords.has(word)) tokens.add(word) })
  for (const char of normalized) {
    if (/[一-鿿]/.test(char)) tokens.add(char)
  }
  return tokens
}

const coverage = (containerTokens: Set<string>, partTokens: Set<string>) => {
  if (!partTokens.size) return 0
  let covered = 0
  partTokens.forEach((token) => { if (containerTokens.has(token)) covered += 1 })
  return covered / partTokens.size
}

export interface MigrationStats {
  exact: number
  moved: number
  similar: number
  split: number
  merge: number
  duplicate: number
  manual: number
  new: number
  removed: number
  pending: number
}

export const summarizeSession = (session: MigrationSession): MigrationStats => {
  const stats: MigrationStats = { exact: 0, moved: 0, similar: 0, split: 0, merge: 0, duplicate: 0, manual: 0, new: 0, removed: 0, pending: session.pending.length }
  for (const match of session.matches) stats[match.kind as keyof Omit<MigrationStats, 'pending'>] += 1
  return stats
}

const maxMembers = 3
const containmentThreshold = 0.92
const similarThreshold = 0.7

/**
 * 规划一次版本迁移：
 * 1. 原始文本完全相同 → 精确沿用（位置变化记为 moved）
 * 2. 重复文本 → duplicate 待决定，交由译者逐项指定
 * 3. 旧块被拆开 / 新块由多块合并 → split/merge 待决定
 * 4. 其余一一模糊匹配（轻改）→ similar，自动沿用并待复核
 * 5. 未覆盖旧块记 removed 归档，未覆盖新块记 new
 */
export const planMigration = (args: {
  oldSegments: Segment[]
  newSegments: Segment[]
  sourceFile: string
}): MigrationSession => {
  const oldSegments = clone(args.oldSegments)
  const newSegments = clone(args.newSegments).map((segment, index) => ({
    ...segment,
    id: uid('new'),
    index: index + 1,
    targetText: '',
    status: 'draft' as const,
  }))
  const matches: MigrationMatch[] = []
  const pending: MigrationPending[] = []
  const usedOld = new Set<string>()
  const usedNew = new Set<string>()

  // 1) 精确匹配：同文本但位置移动时标记 moved。重复文本整体进入待决定。
  const groupByText = (segments: Segment[]) => {
    const groups = new Map<string, Segment[]>()
    segments.forEach((segment) => {
      const key = segment.sourceText
      groups.set(key, [...(groups.get(key) ?? []), segment])
    })
    return groups
  }
  const oldGroups = groupByText(oldSegments)
  const newGroups = groupByText(newSegments)
  for (const [text, newGroup] of newGroups) {
    const oldGroup = oldGroups.get(text) ?? []
    const duplicated = newGroup.length > 1 || oldGroup.length > 1
    if (!oldGroup.length) continue
    if (duplicated) {
      pending.push({
        id: uid('pending-duplicate'),
        kind: 'duplicate',
        oldSegmentIds: oldGroup.map((segment) => segment.id),
        newSegmentIds: newGroup.map((segment) => segment.id),
        note: `相同段落出现 ${oldGroup.length}（旧版）/ ${newGroup.length}（新版）次，请逐项指定对应关系。`,
      })
      oldGroup.forEach((segment) => usedOld.add(segment.id))
      newGroup.forEach((segment) => usedNew.add(segment.id))
      continue
    }
    const oldSegment = oldGroup[0]
    const newSegment = newGroup[0]
    const kind: MigrationMatchKind = oldSegment.index === newSegment.index ? 'exact' : 'moved'
    matches.push({ id: uid('match'), kind, oldSegmentIds: [oldSegment.id], newSegmentIds: [newSegment.id], similarity: 1 })
    usedOld.add(oldSegment.id)
    usedNew.add(newSegment.id)
  }

  const freeOld = () => oldSegments.filter((segment) => !usedOld.has(segment.id) && segment.kind !== 'code')
  const freeNew = () => newSegments.filter((segment) => !usedNew.has(segment.id) && segment.kind !== 'code')
  const sameKind = (oldSegment: Segment, newSegment: Segment) => oldSegment.kind === newSegment.kind || oldSegment.kind === 'paragraph' || newSegment.kind === 'paragraph'

  // 2) 拆分 / 合并：用词元覆盖度 + 长度比 + 相邻奖励打分，旧新块同时被消耗。
  type Candidate = {
    kind: 'split' | 'merge'
    parent: Segment
    parts: Segment[]
    score: number
  }
  const combinations = (segments: Segment[], size: number): Segment[][] => {
    if (size === 1) return segments.map((segment) => [segment])
    if (size > segments.length) return []
    const result: Segment[][] = []
    const walk = (start: number, picked: Segment[]) => {
      if (picked.length === size) { result.push(picked); return }
      for (let i = start; i <= segments.length - (size - picked.length); i += 1) {
        walk(i + 1, [...picked, segments[i]])
      }
    }
    walk(0, [])
    return result
  }
  const adjacencyScore = (segments: Segment[]) => {
    const indexes = segments.map((segment) => segment.index).sort((a, b) => a - b)
    const span = indexes[indexes.length - 1] - indexes[0] + 1
    return Math.max(0, 1 - (span - indexes.length) / 4)
  }
  const buildCandidates = (
    parents: Segment[],
    partsPool: Segment[],
    kind: 'split' | 'merge',
  ): Candidate[] => {
    const candidates: Candidate[] = []
    for (const parent of parents) {
      const parentTokens = tokenSet(parent.sourceText)
      let best: Candidate | null = null
      for (let size = 2; size <= maxMembers; size += 1) {
        for (const parts of combinations(partsPool, size)) {
          if (kind === 'split') {
            if (!parts.every((part) => sameKind(parent, part))) continue
          } else if (!sameKind(parts[0], parent)) {
            continue
          }
          const partTokens = parts.map((part) => tokenSet(part.sourceText))
          const union = new Set<string>()
          partTokens.forEach((tokens) => tokens.forEach((token) => union.add(token)))
          const coverParent = coverage(union, parentTokens)
          const coverParts = partTokens.reduce((sum, tokens) => sum + coverage(parentTokens, tokens), 0) / partTokens.length
          const weakestPart = Math.min(...partTokens.map((tokens) => coverage(parentTokens, tokens)))
          const lengthRatio = Math.min(parent.sourceText.length, parts.reduce((sum, part) => sum + part.sourceText.length, 0)) /
            Math.max(parent.sourceText.length, parts.reduce((sum, part) => sum + part.sourceText.length, 0))
          // 拆分要求子块并集基本覆盖父块；合并允许新增连接词，改用双向覆盖的对称门控。
          const symmetric = Math.min(coverParent, coverParts)
          if (weakestPart < 0.4 || lengthRatio < 0.5) continue
          if (kind === 'split' && (coverParent < containmentThreshold || coverParts < 0.55)) continue
          if (kind === 'merge' && symmetric < 0.7) continue
          const candidate: Candidate = {
            kind,
            parent,
            parts,
            score: coverParent * 0.5 + coverParts * 0.2 + lengthRatio * 0.15 + adjacencyScore(parts) * 0.15,
          }
          if (!best || candidate.score > best.score) best = candidate
        }
      }
      if (best) candidates.push(best)
    }
    return candidates
  }

  let changed = true
  while (changed) {
    changed = false
    const splitCandidates = buildCandidates(freeOld(), freeNew(), 'split')
    const mergeCandidates = buildCandidates(freeNew(), freeOld(), 'merge')
    const best = [...splitCandidates, ...mergeCandidates].sort((a, b) => b.score - a.score)[0]
    if (best) {
      pending.push({
        id: uid(`pending-${best.kind}`),
        kind: best.kind,
        oldSegmentIds: best.kind === 'split' ? [best.parent.id] : best.parts.map((segment) => segment.id),
        newSegmentIds: best.kind === 'split' ? best.parts.map((segment) => segment.id) : [best.parent.id],
        note: best.kind === 'split' ? '旧内容块疑似拆分为多个新块，请确认拆分关系。' : '多个旧内容块疑似合并为一个新块，请确认合并关系。',
      })
      best.kind === 'split' ? usedOld.add(best.parent.id) : best.parts.forEach((segment) => usedOld.add(segment.id))
      best.kind === 'split' ? best.parts.forEach((segment) => usedNew.add(segment.id)) : usedNew.add(best.parent.id)
      changed = true
    }
  }

  // 3) 一一模糊匹配：轻改文字。
  const fuzzyPairs: { oldSegment: Segment; newSegment: Segment; score: number }[] = []
  for (const oldSegment of freeOld()) {
    for (const newSegment of freeNew()) {
      if (!sameKind(oldSegment, newSegment)) continue
      const score = similarity(oldSegment.sourceText, newSegment.sourceText)
      if (score >= similarThreshold) fuzzyPairs.push({ oldSegment, newSegment, score })
    }
  }
  fuzzyPairs.sort((a, b) => b.score - a.score)
  for (const pair of fuzzyPairs) {
    if (usedOld.has(pair.oldSegment.id) || usedNew.has(pair.newSegment.id)) continue
    matches.push({
      id: uid('match'),
      kind: 'similar',
      oldSegmentIds: [pair.oldSegment.id],
      newSegmentIds: [pair.newSegment.id],
      similarity: Math.round(pair.score * 100) / 100,
    })
    usedOld.add(pair.oldSegment.id)
    usedNew.add(pair.newSegment.id)
  }

  reconcile(matches, pending, oldSegments, newSegments)

  return {
    id: uid('migration'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceFile: args.sourceFile,
    oldSegments,
    newSegments,
    matches,
    pending,
    archived: [],
  }
}

/**
 * 依据真实对应关系（非 new/removed 占位）与待决定项重建 new/removed 占位。
 * 占位本身不计入覆盖，否则重复项确认过程中新增/移除块会被错误吞掉。
 */
const reconcile = (
  matches: MigrationMatch[],
  pending: MigrationPending[],
  oldSegments: Segment[],
  newSegments: Segment[],
) => {
  const coveredOld = new Set<string>()
  const coveredNew = new Set<string>()
  for (const match of matches) {
    if (match.kind === 'new' || match.kind === 'removed') continue
    match.oldSegmentIds.forEach((id) => coveredOld.add(id))
    match.newSegmentIds.forEach((id) => coveredNew.add(id))
  }
  for (const item of pending) {
    item.oldSegmentIds.forEach((id) => coveredOld.add(id))
    item.newSegmentIds.forEach((id) => coveredNew.add(id))
  }
  const retained = matches.filter((match) => match.kind !== 'new' && match.kind !== 'removed')
  for (const oldSegment of oldSegments) {
    if (!coveredOld.has(oldSegment.id)) {
      retained.push({ id: uid('match'), kind: 'removed', oldSegmentIds: [oldSegment.id], newSegmentIds: [] })
    }
  }
  for (const newSegment of newSegments) {
    if (!coveredNew.has(newSegment.id)) {
      retained.push({ id: uid('match'), kind: 'new', oldSegmentIds: [], newSegmentIds: [newSegment.id] })
    }
  }
  matches.splice(0, matches.length, ...retained)
}

const commit = (session: MigrationSession): MigrationSession => {
  reconcile(session.matches, session.pending, session.oldSegments, session.newSegments)
  return { ...session, updatedAt: Date.now() }
}

/**
 * 重复段落：为某个新块指定对应的旧块。
 * 每个新块都指派（或标记为新增）后该项自动完成；剩余旧块归为移除。
 */
export const setDuplicatePair = (session: MigrationSession, pendingId: string, newSegmentId: string, oldSegmentId: string | null): MigrationSession => {
  const next = clone(session)
  const item = next.pending.find((pending) => pending.id === pendingId)
  if (!item || item.kind !== 'duplicate') return session
  next.matches = next.matches.filter((match) => !match.newSegmentIds.includes(newSegmentId))
  if (oldSegmentId) {
    next.matches = next.matches.filter((match) => !match.oldSegmentIds.includes(oldSegmentId))
    next.matches.push({ id: uid('match'), kind: 'duplicate', oldSegmentIds: [oldSegmentId], newSegmentIds: [newSegmentId], similarity: 1 })
  } else {
    next.matches.push({ id: uid('match'), kind: 'new', oldSegmentIds: [], newSegmentIds: [newSegmentId] })
  }
  const assignedNew = new Set(next.matches.filter((match) => item.newSegmentIds.some((id) => match.newSegmentIds.includes(id))).flatMap((match) => match.newSegmentIds))
  if (item.newSegmentIds.every((id) => assignedNew.has(id))) {
    next.pending = next.pending.filter((pending) => pending.id !== pendingId)
  }
  return commit(next)
}

/** 重置某个重复待决定项的全部配对，回到初始待决定状态。 */
export const resetDuplicateGroup = (session: MigrationSession, pendingId: string): MigrationSession => {
  const next = clone(session)
  const item = next.pending.find((pending) => pending.id === pendingId)
  if (!item || item.kind !== 'duplicate') return session
  next.matches = next.matches.filter(
    (match) => !item.newSegmentIds.some((id) => match.newSegmentIds.includes(id)) &&
      !item.oldSegmentIds.some((id) => match.oldSegmentIds.includes(id)),
  )
  return commit(next)
}

const resolveGroup = (session: MigrationSession, pendingId: string): MigrationSession => {
  const next = clone(session)
  const index = next.pending.findIndex((pending) => pending.id === pendingId)
  if (index < 0) return session
  const item = next.pending[index]
  next.pending.splice(index, 1)
  const hasNew = item.newSegmentIds.length > 0
  const hasOld = item.oldSegmentIds.length > 0
  if (hasNew && hasOld) {
    next.matches = next.matches.filter(
      (match) => !item.oldSegmentIds.some((id) => match.oldSegmentIds.includes(id)) &&
        !item.newSegmentIds.some((id) => match.newSegmentIds.includes(id)),
    )
    next.matches.push({ id: uid('match'), kind: 'manual', oldSegmentIds: item.oldSegmentIds, newSegmentIds: item.newSegmentIds })
  }
  return commit(next)
}

/** 确认拆分关系（译者可在确认前增删成员）。 */
export const resolveSplit = (session: MigrationSession, pendingId: string): MigrationSession => resolveGroup(session, pendingId)

/** 确认合并关系。 */
export const resolveMerge = (session: MigrationSession, pendingId: string): MigrationSession => resolveGroup(session, pendingId)

/** 放弃该待决定项，涉及的旧/新块重新回到自由池，由 reconcile 归为移除/新增。 */
export const dismissPending = (session: MigrationSession, pendingId: string): MigrationSession => {
  const next = clone(session)
  const index = next.pending.findIndex((pending) => pending.id === pendingId)
  if (index < 0) return session
  const item = next.pending[index]
  next.pending.splice(index, 1)
  next.matches = next.matches.filter(
    (match) => !item.oldSegmentIds.some((id) => match.oldSegmentIds.includes(id)) &&
      !item.newSegmentIds.some((id) => match.newSegmentIds.includes(id)),
  )
  return commit(next)
}

/** 待决定项中加入/移除一个成员（仅允许加入尚未被其它关系占用的块）。 */
export const togglePendingMember = (
  session: MigrationSession,
  pendingId: string,
  side: 'old' | 'new',
  segmentId: string,
): MigrationSession => {
  const next = clone(session)
  const item = next.pending.find((pending) => pending.id === pendingId)
  if (!item) return session
  const pool = side === 'old' ? next.oldSegments : next.newSegments
  if (!pool.some((segment) => segment.id === segmentId)) return session
  const occupied = next.matches.some((match) =>
    side === 'old' ? match.oldSegmentIds.includes(segmentId) : match.newSegmentIds.includes(segmentId),
  ) || next.pending.some((other) =>
    other.id !== item.id && (side === 'old' ? other.oldSegmentIds.includes(segmentId) : other.newSegmentIds.includes(segmentId)),
  )
  const ids = side === 'old' ? item.oldSegmentIds : item.newSegmentIds
  const existingIndex = ids.indexOf(segmentId)
  if (existingIndex >= 0) {
    ids.splice(existingIndex, 1)
  } else if (!occupied) {
    ids.push(segmentId)
    ids.sort((a, b) => {
      const segmentA = pool.find((segment) => segment.id === a)?.index ?? 0
      const segmentB = pool.find((segment) => segment.id === b)?.index ?? 0
      return segmentA - segmentB
    })
  }
  return next
}

export const availableForPending = (session: MigrationSession, pendingId: string, side: 'old' | 'new') => {
  const item = session.pending.find((pending) => pending.id === pendingId)
  if (!item) return []
  const pool = side === 'old' ? session.oldSegments : session.newSegments
  return pool.filter((segment) => {
    const inThis = (side === 'old' ? item.oldSegmentIds : item.newSegmentIds).includes(segment.id)
    if (inThis) return true
    const inMatch = session.matches.some((match) =>
      side === 'old' ? match.oldSegmentIds.includes(segment.id) : match.newSegmentIds.includes(segment.id),
    )
    const inOther = session.pending.some((other) =>
      other.id !== item.id && (side === 'old' ? other.oldSegmentIds : other.newSegmentIds).includes(segment.id),
    )
    return !inMatch && !inOther
  })
}

export interface AppliedMigration {
  segments: Segment[]
  discussions: Discussion[]
  history: HistoryEntry[]
  conflicts: TranslationConflict[]
  archived: ArchivedSegment[]
}

/** 应用迁移：按对应块恢复译文、讨论、状态、历史；轻改/拆分/合并标记待复核；旧内容归档。 */
export const applyMigration = (
  session: MigrationSession,
  context: {
    discussions: Discussion[]
    history: HistoryEntry[]
    conflicts: TranslationConflict[]
  },
): AppliedMigration => {
  if (session.pending.length > 0) {
    throw new Error('still-pending')
  }
  const now = Date.now()
  const oldById = new Map(session.oldSegments.map((segment) => [segment.id, segment]))
  const newById = new Map(session.newSegments.map((segment) => [segment.id, segment]))
  const idMap = new Map<string, string>()
  const segments: Segment[] = []
  const discussions: Discussion[] = []
  const history: HistoryEntry[] = []
  const conflicts: TranslationConflict[] = []
  const archived: ArchivedSegment[] = []

  const targetMatches = session.matches.filter((match) => match.kind !== 'removed')
  // 逐新块产出：拆分关系中只有首个新块沿用旧译文，其余成员留空待译；讨论/冲突汇总进首块。
  const orderedNewIds = targetMatches
    .flatMap((match) => match.newSegmentIds)
    .sort((a, b) => (newById.get(a)?.index ?? 0) - (newById.get(b)?.index ?? 0))
  let order = 0
  for (const newId of orderedNewIds) {
    const newSegment = newById.get(newId)
    if (!newSegment) continue
    const match = targetMatches.find((item) => item.newSegmentIds.includes(newId))!
    const oldRelated = match.oldSegmentIds.map((id) => oldById.get(id)).filter((segment): segment is Segment => Boolean(segment))
    const isFirstNew = match.newSegmentIds[0] === newId
    const carried = isFirstNew ? oldRelated[0] : undefined
    order += 1
    const nextId = `segment-migrated-${order}`
    idMap.set(newId, nextId)
    const needsReview = match.kind === 'similar' || match.kind === 'split' || match.kind === 'merge' || match.kind === 'manual'
    const nextSegment: Segment = {
      ...newSegment,
      id: nextId,
      protectedTokens: extractProtected(newSegment.sourceText),
      targetText: carried?.targetText ?? '',
      // 精确/移动/重复配对：恢复原确认状态；轻改/拆分/合并/人工：沿用译文但必须复核。
      status: carried
        ? needsReview
          ? 'needs-review'
          : carried.status
        : needsReview
          ? 'needs-review'
          : 'draft',
      note: carried?.note ?? '',
      migratedFrom: carried?.id,
      migratedMatch: match.kind,
    }
    segments.push(nextSegment)

    if (isFirstNew) {
      oldRelated.forEach((oldSegment, relationIndex) => {
        context.discussions
          .filter((discussion) => discussion.segmentId === oldSegment.id)
          .forEach((discussion, discussionIndex) => {
            discussions.push({
              ...discussion,
              id: relationIndex === 0 && discussionIndex === 0 ? discussion.id : uid('discussion'),
              segmentId: nextId,
            })
          })
        history.push({
          id: uid('history'),
          segmentId: nextId,
          author: '版本迁移',
          action: 'migrate',
          before: oldSegment.sourceText,
          after: carried
            ? `沿用旧版块 #${oldSegment.index} 的译文（${matchLabel(match.kind)}）`
            : `关联旧版块 #${oldSegment.index}（${matchLabel(match.kind)}），请人工复核。`,
          createdAt: now,
        })
        context.conflicts
          .filter((conflict) => conflict.segmentId === oldSegment.id)
          .forEach((conflict) => conflicts.push({ ...conflict, id: uid('conflict'), segmentId: nextId, createdAt: now }))
      })
    }
    if (match.kind === 'new') {
      history.push({
        id: uid('history'),
        segmentId: nextId,
        author: '版本迁移',
        action: 'migrate',
        before: '',
        after: '新版新增内容块，无旧译文可沿用。',
        createdAt: now,
      })
    }
  }

  // 未对应到新块的旧内容整体归档：译文、讨论、历史、冲突一并保留。
  session.matches
    .filter((match) => match.kind === 'removed')
    .flatMap((match) => match.oldSegmentIds)
    .forEach((oldId) => {
      const oldSegment = oldById.get(oldId)
      if (!oldSegment) return
      archived.push({
        segment: { ...oldSegment, migratedMatch: 'removed' },
        discussions: clone(context.discussions.filter((discussion) => discussion.segmentId === oldId)),
        history: clone(context.history.filter((entry) => entry.segmentId === oldId)),
        conflicts: clone(context.conflicts.filter((conflict) => conflict.segmentId === oldId)),
        archivedAt: now,
      })
      history.push({
        id: uid('history'),
        segmentId: oldId,
        author: '版本迁移',
        action: 'migrate',
        before: oldSegment.sourceText,
        after: '旧版内容块已移除，译文随内容归档。',
        createdAt: now,
      })
    })

  // 旧历史：匹配到新块的按新块 id 重映射（拆分时全部指向首个新块）；移除块的留在归档；其余原样保留。
  const oldToTargetId = new Map<string, string>()
  session.matches
    .filter((match) => match.kind !== 'removed' && match.newSegmentIds.length > 0)
    .forEach((match) => {
      const targetId = idMap.get(match.newSegmentIds[0] ?? '')
      if (targetId) match.oldSegmentIds.forEach((oldId) => { if (!oldToTargetId.has(oldId)) oldToTargetId.set(oldId, targetId) })
    })
  const removedIds = new Set(session.matches.filter((match) => match.kind === 'removed').flatMap((match) => match.oldSegmentIds))
  context.history.forEach((entry) => {
    const mapped = oldToTargetId.get(entry.segmentId)
    if (mapped) {
      history.push({ ...entry, segmentId: mapped })
    } else if (!removedIds.has(entry.segmentId)) {
      history.push(entry)
    }
  })

  return {
    segments: segments.map((segment, index) => ({ ...segment, index: index + 1 })),
    discussions: dedupe(discussions, (discussion) => discussion.id),
    history: dedupe(history, (entry) => entry.id).sort((a, b) => b.createdAt - a.createdAt),
    conflicts: dedupe(conflicts, (conflict) => conflict.id),
    archived,
  }
}

const dedupe = <T,>(items: T[], keyOf: (item: T) => string): T[] => {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = keyOf(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const matchLabel = (kind: MigrationMatchKind): string => {
  switch (kind) {
    case 'exact': return '完全相同'
    case 'moved': return '位置移动'
    case 'similar': return '文字轻改'
    case 'split': return '拆分'
    case 'merge': return '合并'
    case 'duplicate': return '重复段落'
    case 'manual': return '人工指定'
    case 'new': return '新版新增'
    case 'removed': return '旧版移除'
  }
}

export const loadMigrationSession = (): MigrationSession | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(MIGRATION_STORAGE_KEY)
    return raw ? JSON.parse(raw) as MigrationSession : null
  } catch {
    return null
  }
}

export const saveMigrationSession = (session: MigrationSession | null) => {
  if (typeof window === 'undefined') return
  try {
    if (session) window.localStorage.setItem(MIGRATION_STORAGE_KEY, JSON.stringify(session))
    else window.localStorage.removeItem(MIGRATION_STORAGE_KEY)
  } catch { /* storage may be unavailable */ }
}
