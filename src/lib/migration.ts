import { extractProtected, parseMarkdown } from './markdown'
import type { Discussion, HistoryEntry, Segment, SegmentStatus, TranslationConflict } from './types'

/** 相似度达到该阈值才认为新旧内容块可能对应。 */
export const FUZZY_THRESHOLD = 0.62
/** 次优候选与最优候选的分差小于该值时，判为歧义，交人工决定。 */
const AMBIGUITY_MARGIN = 0.12
/** 歧义候选的最低相似度（低于此值不再追问）。 */
const AMBIGUITY_FLOOR = 0.5

export type MigrationDecisionKind = 'duplicate' | 'split' | 'merge' | 'ambiguous'

export interface MigrationBlock {
  id: string
  index: number
  kind: Segment['kind']
  sourceText: string
  targetText: string
  status: SegmentStatus
  note: string
  protectedTokens: string[]
}

export interface MigrationPair {
  oldId: string
  newId: string
  kind: 'exact' | 'fuzzy'
  similarity: number
}

export interface MigrationDecision {
  id: string
  kind: MigrationDecisionKind
  oldIds: string[]
  newIds: string[]
  /** 系统推荐的 newId -> oldId 对应关系（null 表示无对应，作为新增）。 */
  recommended: Record<string, string | null>
  /** 译者确认后的 newId -> oldId 对应关系。 */
  resolution: Record<string, string | null>
  resolved: boolean
}

export interface ArchivedBlock {
  block: MigrationBlock
  discussions: Discussion[]
  history: HistoryEntry[]
  conflicts: TranslationConflict[]
  archivedAt: number
}

export interface MigrationPlan {
  id: string
  fileName: string
  createdAt: number
  oldBlocks: MigrationBlock[]
  newBlocks: MigrationBlock[]
  pairs: MigrationPair[]
  decisions: MigrationDecision[]
  archived: ArchivedBlock[]
}

export interface MigrationApplyResult {
  segments: Segment[]
  discussions: Discussion[]
  history: HistoryEntry[]
  conflicts: TranslationConflict[]
  archive: ArchivedBlock[]
}

export const normalizeText = (text: string): string => text.replace(/\s+/g, ' ').trim()

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

const bigramSet = (text: string): Set<string> => {
  const set = new Set<string>()
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2))
  return set
}

function bigramJaccard(a: string, b: string): number {
  const A = bigramSet(a)
  const B = bigramSet(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  A.forEach((gram) => { if (B.has(gram)) inter++ })
  const union = A.size + B.size - inter
  return union ? inter / union : 0
}

/** 重叠系数：较短文本的二元组中有多少比例出现在较长文本中（包含关系信号）。 */
function bigramOverlap(a: string, b: string): number {
  const A = bigramSet(a)
  const B = bigramSet(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  A.forEach((gram) => { if (B.has(gram)) inter++ })
  const smaller = A.size <= B.size ? A : B
  return inter / smaller.size
}

/** 两个文本块的相似度：完全相同为 1，无关为 0。短文本用编辑距离，长文本用二元组 Jaccard；包含关系（拆分/合并）额外加权。 */
export function similarity(a: string, b: string): number {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (na === nb) return 1
  if (!na || !nb) return 0
  const maxLen = Math.max(na.length, nb.length)
  const minLen = Math.min(na.length, nb.length)
  const levRatio = maxLen <= 800 ? 1 - levenshtein(na, nb) / maxLen : bigramJaccard(na, nb)
  // 包含关系：一个文本块基本是另一个的子块（拆分/合并场景），且子块足够长（>=35%）才加权。
  const ratio = minLen / maxLen
  if (ratio >= 0.35 && bigramOverlap(na, nb) >= 0.8) {
    return Math.max(levRatio, Math.min(0.95, 0.65 + ratio * 0.3))
  }
  return levRatio
}

const toBlock = (segment: Segment): MigrationBlock => ({
  id: segment.id,
  index: segment.index,
  kind: segment.kind,
  sourceText: segment.sourceText,
  targetText: segment.targetText,
  status: segment.status,
  note: segment.note,
  protectedTokens: segment.protectedTokens,
})

const groupBy = <T,>(items: T[], key: (item: T) => string): Map<string, T[]> => {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = map.get(k) ?? []
    list.push(item)
    map.set(k, list)
  }
  return map
}

interface Edge {
  oldId: string
  newId: string
  score: number
}

let decisionSeq = 0

function edgeScoreOf(edges: Edge[], oldId: string, newId: string): number {
  return edges.find((e) => e.oldId === oldId && e.newId === newId)?.score ?? 0
}

function buildDecision(
  oldIds: string[],
  newIds: string[],
  edges: Edge[],
  kind: MigrationDecisionKind,
): MigrationDecision {
  const recommended: Record<string, string | null> = {}
  if (kind === 'split') {
    // 一个旧块拆成多个新块：旧译文由相似度最高的新块继承，其余按新增处理。
    const oldId = oldIds[0]
    let bestNew: string | null = null
    let bestScore = -1
    for (const n of newIds) {
      const s = edgeScoreOf(edges, oldId, n)
      if (s > bestScore) { bestScore = s; bestNew = n }
    }
    for (const n of newIds) recommended[n] = n === bestNew ? oldId : null
  } else if (kind === 'merge') {
    // 多个旧块合并为一个新块：保留相似度最高的旧块译文，其余归档。
    const newId = newIds[0]
    let bestOld: string | null = null
    let bestScore = -1
    for (const o of oldIds) {
      const s = edgeScoreOf(edges, o, newId)
      if (s > bestScore) { bestScore = s; bestOld = o }
    }
    recommended[newId] = bestOld
  } else {
    // 歧义：每个新块取相似度最高的旧块。
    for (const n of newIds) {
      let best: string | null = null
      let bestScore = -1
      for (const o of oldIds) {
        const s = edgeScoreOf(edges, o, n)
        if (s > bestScore) { bestScore = s; best = s > 0 ? o : null }
      }
      recommended[n] = best
    }
  }
  const id = `decision-${kind}-${Date.now()}-${decisionSeq++}`
  return { id, kind, oldIds, newIds, recommended, resolution: { ...recommended }, resolved: false }
}

function buildDuplicateDecision(oldGroup: MigrationBlock[], newGroup: MigrationBlock[]): MigrationDecision {
  const oldIds = oldGroup.map((b) => b.id)
  const newIds = newGroup.map((b) => b.id)
  const recommended: Record<string, string | null> = {}
  newIds.forEach((n, i) => { recommended[n] = oldIds[i] ?? null })
  const id = `decision-duplicate-${Date.now()}-${decisionSeq++}`
  return { id, kind: 'duplicate', oldIds, newIds, recommended, resolution: { ...recommended }, resolved: false }
}

/** 在孤立块（没有任何达到阈值的对应关系）中寻找次优候选，判断是否需要追加歧义决定。。 */
function findAmbiguousAlternative(
  oldBlock: MigrationBlock,
  newBlock: MigrationBlock,
  score: number,
  isolatedOld: MigrationBlock[],
  isolatedNew: MigrationBlock[],
): { oldId?: string; newId?: string } | null {
  const floor = Math.max(AMBIGUITY_FLOOR, score - AMBIGUITY_MARGIN)
  let altNew: string | null = null
  let altNewScore = -1
  for (const n of isolatedNew) {
    if (n.id === newBlock.id) continue
    const s = similarity(oldBlock.sourceText, n.sourceText)
    if (s >= floor && s > altNewScore) { altNewScore = s; altNew = n.id }
  }
  let altOld: string | null = null
  let altOldScore = -1
  for (const o of isolatedOld) {
    if (o.id === oldBlock.id) continue
    const s = similarity(o.sourceText, newBlock.sourceText)
    if (s >= floor && s > altOldScore) { altOldScore = s; altOld = o.id }
  }
  if (!altNew && !altOld) return null
  return { oldId: altOld ?? undefined, newId: altNew ?? undefined }
}

/**
 * 分析新旧文档的内容块对应关系，生成迁移计划。
 * - 完全相同（归一化后）的块自动沿用译文，位置移动也能追回；
 * - 轻度改动的块模糊匹配，保留译文并标记待复核；
 * - 重复段落、拆分、合并、歧义块列为待决定项；
 * - 无对应的旧块归档，无对应的新块按新增处理。
 */
export function analyzeMigration(
  segments: Segment[],
  markdown: string,
  fileName: string,
  discussions: Discussion[],
  history: HistoryEntry[],
  conflicts: TranslationConflict[],
): MigrationPlan {
  decisionSeq = 0
  const oldBlocks = segments.map(toBlock)
  const newBlocks = parseMarkdown(markdown).map(toBlock)

  const pairs: MigrationPair[] = []
  const decisions: MigrationDecision[] = []
  const usedOld = new Set<string>()
  const usedNew = new Set<string>()

  // ---- 第一轮：完全相同的块（与位置无关）----
  const oldGroups = groupBy(oldBlocks, (b) => normalizeText(b.sourceText))
  const newGroups = groupBy(newBlocks, (b) => normalizeText(b.sourceText))

  for (const [norm, oldGroup] of oldGroups) {
    const newGroup = newGroups.get(norm) ?? []
    if (oldGroup.length === 1 && newGroup.length === 1) {
      pairs.push({ oldId: oldGroup[0].id, newId: newGroup[0].id, kind: 'exact', similarity: 1 })
      usedOld.add(oldGroup[0].id)
      usedNew.add(newGroup[0].id)
    } else if (oldGroup.length > 0 && newGroup.length > 0 && (oldGroup.length > 1 || newGroup.length > 1)) {
      decisions.push(buildDuplicateDecision(oldGroup, newGroup))
      oldGroup.forEach((b) => usedOld.add(b.id))
      newGroup.forEach((b) => usedNew.add(b.id))
    }
  }

  // ---- 第二轮：模糊匹配 ----
  const freeOld = oldBlocks.filter((b) => !usedOld.has(b.id))
  const freeNew = newBlocks.filter((b) => !usedNew.has(b.id))

  const edges: Edge[] = []
  for (const o of freeOld) {
    for (const n of freeNew) {
      const score = similarity(o.sourceText, n.sourceText)
      if (score >= FUZZY_THRESHOLD) edges.push({ oldId: o.id, newId: n.id, score })
    }
  }

  // 用并查集把达到阈值的边连成组件
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root) ?? root
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) ?? root
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  freeOld.forEach((b) => parent.set(b.id, b.id))
  freeNew.forEach((b) => parent.set(b.id, b.id))
  edges.forEach((e) => union(e.oldId, e.newId))

  const componentMap = new Map<string, { oldIds: string[]; newIds: string[] }>()
  for (const b of freeOld) {
    const root = find(b.id)
    const comp = componentMap.get(root) ?? { oldIds: [], newIds: [] }
    comp.oldIds.push(b.id)
    componentMap.set(root, comp)
  }
  for (const b of freeNew) {
    const root = find(b.id)
    const comp = componentMap.get(root) ?? { oldIds: [], newIds: [] }
    comp.newIds.push(b.id)
    componentMap.set(root, comp)
  }

  const blockById = new Map<string, MigrationBlock>()
  oldBlocks.forEach((b) => blockById.set(b.id, b))
  newBlocks.forEach((b) => blockById.set(b.id, b))

  const newWithEdge = new Set(edges.map((e) => e.newId))
  const oldWithEdge = new Set(edges.map((e) => e.oldId))
  const isolatedOld = freeOld.filter((b) => !oldWithEdge.has(b.id))
  const isolatedNew = freeNew.filter((b) => !newWithEdge.has(b.id))

  for (const comp of componentMap.values()) {
    const { oldIds, newIds } = comp
    if (!oldIds.length || !newIds.length) continue // 孤立块：稍后归档或新增
    if (oldIds.length === 1 && newIds.length === 1) {
      const oldId = oldIds[0]
      const newId = newIds[0]
      const score = edgeScoreOf(edges, oldId, newId)
      const alt = findAmbiguousAlternative(
        blockById.get(oldId)!,
        blockById.get(newId)!,
        score,
        isolatedOld,
        isolatedNew,
      )
      if (alt && (alt.oldId || alt.newId)) {
        const altOldIds = Array.from(new Set([oldId, alt.oldId].filter((x): x is string => !!x)))
        const altNewIds = Array.from(new Set([newId, alt.newId].filter((x): x is string => !!x)))
        decisions.push(buildDecision(altOldIds, altNewIds, edges, 'ambiguous'))
        altOldIds.forEach((id) => usedOld.add(id))
        altNewIds.forEach((id) => usedNew.add(id))
      } else {
        pairs.push({ oldId, newId, kind: 'fuzzy', similarity: score })
        usedOld.add(oldId)
        usedNew.add(newId)
      }
    } else {
      const kind: MigrationDecisionKind = oldIds.length === 1 ? 'split' : newIds.length === 1 ? 'merge' : 'ambiguous'
      decisions.push(buildDecision(oldIds, newIds, edges, kind))
      oldIds.forEach((id) => usedOld.add(id))
      newIds.forEach((id) => usedNew.add(id))
    }
  }

  // ---- 收尾：未对应的旧块归档，未对应的新块新增 ----
  const pairOld = new Set(pairs.map((p) => p.oldId))
  const pairNew = new Set(pairs.map((p) => p.newId))
  const decisionOld = new Set(decisions.flatMap((d) => d.oldIds))
  const decisionNew = new Set(decisions.flatMap((d) => d.newIds))

  const archivedOld = oldBlocks.filter((b) => !pairOld.has(b.id) && !decisionOld.has(b.id))

  const archived: ArchivedBlock[] = archivedOld.map((b) => ({
    block: b,
    discussions: discussions.filter((d) => d.segmentId === b.id),
    history: history.filter((h) => h.segmentId === b.id),
    conflicts: conflicts.filter((c) => c.segmentId === b.id),
    archivedAt: Date.now(),
  }))

  return {
    id: `migration-${Date.now()}`,
    fileName,
    createdAt: Date.now(),
    oldBlocks,
    newBlocks,
    pairs,
    decisions,
    archived,
  }
}

export const pendingDecisionCount = (plan: MigrationPlan | null): number =>
  plan ? plan.decisions.filter((d) => !d.resolved).length : 0

export const allDecisionsResolved = (plan: MigrationPlan): boolean =>
  plan.decisions.every((d) => d.resolved)

export function updateResolution(
  plan: MigrationPlan,
  decisionId: string,
  newId: string,
  oldId: string | null,
): MigrationPlan {
  return {
    ...plan,
    decisions: plan.decisions.map((d) =>
      d.id === decisionId
        ? { ...d, resolution: { ...d.resolution, [newId]: oldId }, resolved: true }
        : d,
    ),
  }
}

export function acceptAllRecommendations(plan: MigrationPlan): MigrationPlan {
  return {
    ...plan,
    decisions: plan.decisions.map((d) => ({ ...d, resolution: { ...d.recommended }, resolved: true })),
  }
}

/** 应用迁移计划：按对应块恢复译文、讨论、确认状态与历史，未对应的旧块归档。 */
export function applyMigration(
  plan: MigrationPlan,
  current: { discussions: Discussion[]; history: HistoryEntry[]; conflicts: TranslationConflict[] },
): MigrationApplyResult {
  const { discussions, history, conflicts } = current
  const oldBlockById = new Map(plan.oldBlocks.map((b) => [b.id, b]))

  // newId -> oldId | null
  const mapping = new Map<string, string | null>()
  for (const pair of plan.pairs) mapping.set(pair.newId, pair.oldId)
  for (const decision of plan.decisions) {
    for (const [newId, oldId] of Object.entries(decision.resolution)) {
      mapping.set(newId, oldId)
    }
  }

  const newIdToSegmentId = new Map<string, string>()
  plan.newBlocks.forEach((b, i) => newIdToSegmentId.set(b.id, `segment-${plan.id}-${i + 1}`))

  const segments: Segment[] = plan.newBlocks.map((newBlock, index) => {
    const oldId = mapping.get(newBlock.id) ?? null
    const oldBlock = oldId ? oldBlockById.get(oldId) : undefined
    if (oldBlock) {
      const isExact = plan.pairs.some((p) => p.newId === newBlock.id && p.kind === 'exact')
      return {
        id: newIdToSegmentId.get(newBlock.id)!,
        index: index + 1,
        kind: newBlock.kind,
        sourceText: newBlock.sourceText,
        targetText: oldBlock.targetText,
        status: isExact ? oldBlock.status : 'needs-work',
        protectedTokens: extractProtected(newBlock.sourceText),
        note: oldBlock.note,
      }
    }
    return {
      id: newIdToSegmentId.get(newBlock.id)!,
      index: index + 1,
      kind: newBlock.kind,
      sourceText: newBlock.sourceText,
      targetText: '',
      status: 'draft',
      protectedTokens: extractProtected(newBlock.sourceText),
      note: '',
    }
  })

  const remap = (oldSegmentId: string): string | null => {
    for (const [newId, oldId] of mapping) {
      if (oldId === oldSegmentId) return newIdToSegmentId.get(newId) ?? null
    }
    return null
  }

  const newDiscussions: Discussion[] = []
  const archivedDiscussions: Discussion[] = []
  for (const d of discussions) {
    const id = remap(d.segmentId)
    if (id) newDiscussions.push({ ...d, segmentId: id })
    else archivedDiscussions.push(d)
  }

  const newHistory: HistoryEntry[] = []
  const archivedHistory: HistoryEntry[] = []
  for (const h of history) {
    const id = remap(h.segmentId)
    if (id) newHistory.push({ ...h, segmentId: id })
    else archivedHistory.push(h)
  }

  const newConflicts: TranslationConflict[] = []
  const archivedConflicts: TranslationConflict[] = []
  for (const c of conflicts) {
    const id = remap(c.segmentId)
    if (id) newConflicts.push({ ...c, segmentId: id })
    else archivedConflicts.push(c)
  }

  const mappedOldIds = new Set<string>()
  for (const oldId of mapping.values()) if (oldId) mappedOldIds.add(oldId)
  const archived: ArchivedBlock[] = plan.oldBlocks
    .filter((b) => !mappedOldIds.has(b.id))
    .map((b) => ({
      block: b,
      discussions: archivedDiscussions.filter((d) => d.segmentId === b.id),
      history: archivedHistory.filter((h) => h.segmentId === b.id),
      conflicts: archivedConflicts.filter((c) => c.segmentId === b.id),
      archivedAt: Date.now(),
    }))

  return { segments, discussions: newDiscussions, history: newHistory, conflicts: newConflicts, archive: archived }
}
