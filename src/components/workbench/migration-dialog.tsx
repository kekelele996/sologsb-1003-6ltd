'use client'

import { useRef, useState, type ChangeEvent } from 'react'
import {
  Archive, ArrowRight, Check, CheckCheck, ChevronDown, FileUp, GitBranch,
  GitMerge, Layers, Loader2, Scissors, Split, X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  allDecisionsResolved, pendingDecisionCount, similarity,
  type MigrationBlock, type MigrationDecision, type MigrationPlan,
} from '@/lib/migration'

interface MigrationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  plan: MigrationPlan | null
  analyzing: boolean
  applying: boolean
  onPickFile: (file: File) => void
  onUpdateResolution: (decisionId: string, newId: string, oldId: string | null) => void
  onAcceptAll: () => void
  onApply: () => void
  onDiscard: () => void
}

const decisionMeta: Record<MigrationDecision['kind'], { label: string; icon: React.ReactNode; desc: string }> = {
  duplicate: { label: '重复段落', icon: <Layers className="h-3.5 w-3.5" />, desc: '新旧文档中出现相同段落，请逐段指定对应关系。' },
  split: { label: '拆分', icon: <Split className="h-3.5 w-3.5" />, desc: '一个旧段落拆成多个新段落，请指定旧译文由哪段继承。' },
  merge: { label: '合并', icon: <GitMerge className="h-3.5 w-3.5" />, desc: '多个旧段落合并为一个新段落，请指定保留哪段译文。' },
  ambiguous: { label: '歧义', icon: <GitBranch className="h-3.5 w-3.5" />, desc: '存在多个相似候选，请确认新旧对应关系。' },
}

const snippet = (text: string, max = 56): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function Collapsible({ title, badge, children, defaultOpen = false }: { title: string; badge: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50">
        <ChevronDown className={cn('h-3.5 w-3.5 text-slate-400 transition-transform', !open && '-rotate-90')} />
        {title}
        <span className="ml-auto">{badge}</span>
      </button>
      {open && <div className="border-t px-3 py-2">{children}</div>}
    </div>
  )
}

function FileDropzone({ onPickFile, analyzing }: { onPickFile: (file: File) => void; analyzing: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) onPickFile(file)
    event.target.value = ''
  }
  return (
    <div
      className="grid cursor-pointer place-items-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/60 px-6 py-14 text-center transition hover:border-blue-400 hover:bg-blue-50/40"
      onClick={() => inputRef.current?.click()}
    >
      <input ref={inputRef} type="file" accept=".md,.markdown,text/markdown" className="hidden" onChange={handleChange} />
      {analyzing ? <Loader2 className="mb-3 h-8 w-8 animate-spin text-blue-500" /> : <FileUp className="mb-3 h-8 w-8 text-blue-500" />}
      <p className="text-sm font-medium text-slate-700">{analyzing ? '正在分析新旧内容块…' : '选择新版本的 Markdown 文档'}</p>
      <p className="mt-1 max-w-md text-xs leading-5 text-slate-500">
        导入后自动匹配新旧内容块：完全相同的沿用译文，位置移动也能追回；轻改保留译文并标待复核；重复、拆分、合并逐项指定；已移除的内容归档。
      </p>
    </div>
  )
}

function DecisionCard({
  decision,
  oldBlocks,
  newBlocks,
  onUpdate,
}: {
  decision: MigrationDecision
  oldBlocks: MigrationBlock[]
  newBlocks: MigrationBlock[]
  onUpdate: (decisionId: string, newId: string, oldId: string | null) => void
}) {
  const meta = decisionMeta[decision.kind]
  const mappedOld = new Set(Object.values(decision.resolution).filter((v): v is string => !!v))
  const orphanOld = decision.oldIds.filter((id) => !mappedOld.has(id))
  return (
    <Card className={cn('border-l-4', decision.resolved ? 'border-l-emerald-400' : 'border-l-amber-400')}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <span className="text-slate-500">{meta.icon}</span>
          {meta.label}
          <Badge variant={decision.resolved ? 'success' : 'warning'}>{decision.resolved ? '已确认' : '待决定'}</Badge>
          <span className="ml-auto hidden text-[10px] font-normal text-slate-400 sm:inline">{meta.desc}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {decision.newIds.map((newId) => {
          const newBlock = newBlocks.find((b) => b.id === newId)!
          const value = decision.resolution[newId] ?? ''
          return (
            <div key={newId} className="rounded-lg border bg-slate-50/70 p-2.5">
              <div className="flex items-start gap-2">
                <Badge variant="outline" className="mt-0.5 shrink-0">#{newBlock.index}</Badge>
                <p className="line-clamp-2 flex-1 text-xs leading-5 text-slate-700">{snippet(newBlock.sourceText, 80)}</p>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <select
                  value={value}
                  onChange={(event) => onUpdate(decision.id, newId, event.target.value || null)}
                  className="h-8 flex-1 rounded-md border border-input bg-white px-2 text-xs"
                >
                  <option value="">无对应，作为新增段落</option>
                  {decision.oldIds.map((oldId) => {
                    const oldBlock = oldBlocks.find((b) => b.id === oldId)!
                    const pct = Math.round(similarity(oldBlock.sourceText, newBlock.sourceText) * 100)
                    const isRecommended = decision.recommended[newId] === oldId
                    return (
                      <option key={oldId} value={oldId}>
                        #{oldBlock.index} {snippet(oldBlock.sourceText, 40)}
                        {decision.kind === 'duplicate' && oldBlock.targetText ? `（译文：${snippet(oldBlock.targetText, 20)}）` : ''}
                        {decision.kind !== 'duplicate' ? ` · 相似度 ${pct}%` : ''}
                        {isRecommended ? ' · 推荐' : ''}
                      </option>
                    )
                  })}
                </select>
              </div>
            </div>
          )
        })}
        {orphanOld.length > 0 && (
          <p className="flex items-center gap-1 text-[10px] text-slate-400">
            <Archive className="h-3 w-3" />
            未被指定的旧段落将归档：{orphanOld.map((id) => `#${oldBlocks.find((b) => b.id === id)?.index}`).join('、')}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function PlanView({ plan, onUpdateResolution }: { plan: MigrationPlan; onUpdateResolution: (decisionId: string, newId: string, oldId: string | null) => void }) {
  const oldById = new Map(plan.oldBlocks.map((b) => [b.id, b]))
  const newById = new Map(plan.newBlocks.map((b) => [b.id, b]))
  const fuzzyCount = plan.pairs.filter((p) => p.kind === 'fuzzy').length
  const exactCount = plan.pairs.filter((p) => p.kind === 'exact').length
  const addedCount = plan.newBlocks.length - plan.pairs.length - plan.decisions.reduce((n, d) => n + d.newIds.length, 0)
  const pending = pendingDecisionCount(plan)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="success" className="gap-1"><CheckCheck className="h-3 w-3" />完全相同沿用 {exactCount}</Badge>
        <Badge variant="warning" className="gap-1"><Scissors className="h-3 w-3" />轻改待复核 {fuzzyCount}</Badge>
        <Badge variant={pending ? 'destructive' : 'secondary'} className="gap-1"><Layers className="h-3 w-3" />待决定 {pending}</Badge>
        <Badge variant="outline" className="gap-1"><Archive className="h-3 w-3" />已归档 {plan.archived.length}</Badge>
        <Badge variant="secondary" className="gap-1"><FileUp className="h-3 w-3" />新增 {Math.max(0, addedCount)}</Badge>
      </div>

      {plan.decisions.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">待决定项（{plan.decisions.length}）</p>
          {plan.decisions.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} oldBlocks={plan.oldBlocks} newBlocks={plan.newBlocks} onUpdate={onUpdateResolution} />
          ))}
        </div>
      )}

      <Collapsible title="自动沿用的内容块" badge={<Badge variant="secondary">{plan.pairs.length}</Badge>}>
        <div className="space-y-1.5">
          {plan.pairs.map((pair) => {
            const o = oldById.get(pair.oldId)!
            const n = newById.get(pair.newId)!
            return (
              <div key={`${pair.oldId}-${pair.newId}`} className="flex items-center gap-2 text-[11px] text-slate-600">
                <Badge variant="outline" className="shrink-0">#{o.index}</Badge>
                <ArrowRight className="h-3 w-3 shrink-0 text-slate-400" />
                <Badge variant="outline" className="shrink-0">#{n.index}</Badge>
                <span className="truncate text-slate-500">{snippet(n.sourceText, 60)}</span>
                {pair.kind === 'fuzzy' && <Badge variant="warning" className="ml-auto shrink-0">待复核 {Math.round(pair.similarity * 100)}%</Badge>}
                {pair.kind === 'exact' && <Badge variant="success" className="ml-auto shrink-0">完全相同</Badge>}
              </div>
            )
          })}
        </div>
      </Collapsible>

      <Collapsible title="已归档的旧内容块" badge={<Badge variant="secondary">{plan.archived.length}</Badge>}>
        {plan.archived.length === 0 ? (
          <p className="py-2 text-center text-[11px] text-slate-400">没有需要归档的内容块</p>
        ) : (
          <div className="space-y-1.5">
            {plan.archived.map(({ block, discussions, history }) => (
              <div key={block.id} className="flex items-center gap-2 text-[11px] text-slate-500">
                <Badge variant="outline" className="shrink-0">#{block.index}</Badge>
                <span className="truncate">{snippet(block.sourceText, 60)}</span>
                {discussions.length > 0 && <Badge variant="secondary" className="ml-auto shrink-0">讨论 {discussions.length}</Badge>}
                {history.length > 0 && <Badge variant="secondary" className="shrink-0">历史 {history.length}</Badge>}
              </div>
            ))}
          </div>
        )}
      </Collapsible>
    </div>
  )
}

export function MigrationDialog({
  open,
  onOpenChange,
  plan,
  analyzing,
  applying,
  onPickFile,
  onUpdateResolution,
  onAcceptAll,
  onApply,
  onDiscard,
}: MigrationDialogProps) {
  if (!open) return null
  const pending = plan ? pendingDecisionCount(plan) : 0
  const resolved = plan ? allDecisionsResolved(plan) : false

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-950/60 p-4 backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="my-8 w-full max-w-3xl rounded-2xl border bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <GitBranch className="h-4 w-4 text-blue-600" /> 版本迁移
            </h2>
            {plan && (
              <p className="mt-0.5 truncate text-xs text-slate-500">
                {plan.fileName} · {new Date(plan.createdAt).toLocaleString('zh-CN')}
              </p>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}><X className="h-4 w-4" /></Button>
        </div>

        <div className="max-h-[60vh] overflow-auto px-5 py-4">
          {!plan ? (
            <FileDropzone onPickFile={onPickFile} analyzing={analyzing} />
          ) : (
            <PlanView plan={plan} onUpdateResolution={onUpdateResolution} />
          )}
        </div>

        {plan && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-slate-50 px-5 py-3">
            <Button variant="ghost" className="text-slate-500" onClick={onDiscard}>放弃迁移</Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={onAcceptAll} disabled={plan.decisions.length === 0}>
                <CheckCheck className="h-4 w-4" /> 全部接受建议
              </Button>
              <Button onClick={onApply} disabled={!resolved || applying}>
                {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                应用迁移{pending > 0 ? `（剩余 ${pending} 项待决定）` : ''}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
