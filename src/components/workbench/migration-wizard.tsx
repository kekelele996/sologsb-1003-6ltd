'use client'

import { useMemo, useState } from 'react'
import {
  ArrowRight, Check, ChevronRight, Code2, Copy, FileText, GitPullRequestArrow,
  Link2, Loader2, SplitSquareHorizontal, Combine, X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { matchLabel, resetDuplicateGroup, setDuplicatePair, dismissPending, resolveMerge, resolveSplit, summarizeSession, togglePendingMember, availableForPending } from '@/lib/migration'
import type { MigrationMatchKind, MigrationSession, Segment } from '@/lib/types'
import { cn } from '@/lib/utils'

interface MigrationWizardProps {
  session: MigrationSession
  applying: boolean
  onSessionChange: (session: MigrationSession) => void
  onApply: (session: MigrationSession) => void
  onDiscard: () => void
}

type TabKey = 'pending' | 'all' | 'new' | 'removed'

const kindIcon = {
  heading: <FileText className="h-3 w-3" />,
  paragraph: <FileText className="h-3 w-3" />,
  code: <Code2 className="h-3 w-3" />,
  link: <Link2 className="h-3 w-3" />,
  variable: <FileText className="h-3 w-3" />,
}

const matchBadgeClass: Record<MigrationMatchKind, string> = {
  exact: 'bg-emerald-100 text-emerald-800',
  moved: 'bg-sky-100 text-sky-800',
  similar: 'bg-amber-100 text-amber-800',
  split: 'bg-violet-100 text-violet-800',
  merge: 'bg-violet-100 text-violet-800',
  duplicate: 'bg-fuchsia-100 text-fuchsia-800',
  manual: 'bg-indigo-100 text-indigo-800',
  new: 'bg-blue-100 text-blue-800',
  removed: 'bg-slate-200 text-slate-700',
}

function BlockPreview({ segment, tone, badge }: { segment: Segment; tone: 'old' | 'new'; badge?: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg border p-2.5', tone === 'old' ? 'border-slate-200 bg-slate-50' : 'border-blue-200 bg-blue-50/50')}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[10px] font-semibold text-slate-400">#{String(segment.index).padStart(2, '0')}</span>
        <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[9px]">{kindIcon[segment.kind]}</Badge>
        {badge}
      </div>
      <p className={cn('document-prose line-clamp-6 text-[11px] leading-5', tone === 'old' ? 'text-slate-600' : 'text-slate-800')}>{segment.sourceText}</p>
      {segment.targetText
        ? <p className="document-prose mt-1.5 border-t border-dashed pt-1.5 text-[11px] leading-5 text-blue-700">译文：{segment.targetText}</p>
        : <p className="mt-1.5 text-[10px] text-slate-400">尚无译文</p>}
    </div>
  )
}

export function MigrationWizard({ session, applying, onSessionChange, onApply, onDiscard }: MigrationWizardProps) {
  const [tab, setTab] = useState<TabKey>('pending')
  const oldById = useMemo(() => new Map(session.oldSegments.map((segment) => [segment.id, segment])), [session.oldSegments])
  const newById = useMemo(() => new Map(session.newSegments.map((segment) => [segment.id, segment])), [session.newSegments])
  const stats = useMemo(() => summarizeSession(session), [session])

  const resolvedMatches = session.matches.filter((match) => match.kind !== 'new' && match.kind !== 'removed')
  const newMatches = session.matches.filter((match) => match.kind === 'new')
  const removedMatches = session.matches.filter((match) => match.kind === 'removed')

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: 'pending', label: '待决定项', count: session.pending.length },
    { key: 'all', label: '全部对应', count: resolvedMatches.length },
    { key: 'new', label: `新版新增 ${stats.new}`, count: newMatches.length },
    { key: 'removed', label: `旧版移除 ${stats.removed}`, count: removedMatches.length },
  ]

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-slate-100/95 backdrop-blur">
      <header className="border-b border-slate-800 bg-slate-950 px-4 py-3 text-white shadow-xl lg:px-6">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-lg border border-blue-400/30 bg-blue-500/15 text-blue-300"><GitPullRequestArrow className="h-4 w-4" /></div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">版本迁移 · 新旧内容块对应</h2>
            <p className="truncate text-[11px] text-slate-400">{session.sourceFile} · 确认前不会覆盖当前草稿，刷新后可继续处理</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 hover:text-white" onClick={onDiscard} disabled={applying}><X className="h-3.5 w-3.5" />放弃迁移</Button>
            <Button size="sm" onClick={() => onApply(session)} disabled={session.pending.length > 0 || applying} className="bg-emerald-600 hover:bg-emerald-500">
              {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              完成并应用{session.pending.length > 0 ? `（还有 ${session.pending.length} 项待决定）` : ''}
            </Button>
          </div>
        </div>
      </header>

      <div className="border-b bg-white px-4 py-2.5 lg:px-6">
        <div className="mx-auto flex max-w-[1500px] flex-wrap gap-2 text-[11px]">
          <Badge className={matchBadgeClass.exact}>完全相同 {stats.exact}</Badge>
          <Badge className={matchBadgeClass.moved}>位置移动 {stats.moved}</Badge>
          <Badge className={matchBadgeClass.similar}>文字轻改（待复核）{stats.similar}</Badge>
          <Badge className={matchBadgeClass.manual}>拆分/合并/人工 {stats.split + stats.merge + stats.manual}</Badge>
          <Badge className={matchBadgeClass.duplicate}>重复配对 {stats.duplicate}</Badge>
          <Badge className={matchBadgeClass.new}>新增 {stats.new}</Badge>
          <Badge className={matchBadgeClass.removed}>移除归档 {stats.removed}</Badge>
          <Badge variant="warning" className="ml-auto">{session.pending.length} 项待决定</Badge>
        </div>
      </div>

      <div className="border-b bg-white px-4 pt-2 lg:px-6">
        <div className="mx-auto flex max-w-[1500px] gap-1">
          {tabs.map((item) => (
            <button key={item.key} onClick={() => setTab(item.key)} className={cn('relative rounded-t-md px-4 py-2 text-xs font-medium transition', tab === item.key ? 'bg-slate-100 text-blue-700' : 'text-slate-500 hover:text-slate-800')}>
              {item.label}
              {item.count > 0 && <span className={cn('ml-1.5 rounded-full px-1.5 py-0.5 text-[10px]', item.key === 'pending' && item.count ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-600')}>{item.count}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4 lg:px-6">
        <div className="mx-auto max-w-[1500px] space-y-4">
          {tab === 'pending' && (
            session.pending.length ? session.pending.map((item) => {
              const oldBlocks = item.oldSegmentIds.map((id) => oldById.get(id)).filter((segment): segment is Segment => Boolean(segment))
              const newBlocks = item.newSegmentIds.map((id) => newById.get(id)).filter((segment): segment is Segment => Boolean(segment))
              const addableOld = availableForPending(session, item.id, 'old')
              const addableNew = availableForPending(session, item.id, 'new')
              const canResolve = item.kind === 'duplicate' ? false : item.oldSegmentIds.length >= 1 && item.newSegmentIds.length >= 1
              return (
                <Card key={item.id} className="border-amber-300 shadow-sm">
                  <CardContent className="p-4">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <Badge className={matchBadgeClass[item.kind]}>
                        {item.kind === 'duplicate' ? <Copy className="mr-1 h-3 w-3" /> : item.kind === 'split' ? <SplitSquareHorizontal className="mr-1 h-3 w-3" /> : <Combine className="mr-1 h-3 w-3" />}
                        {item.kind === 'duplicate' ? '重复段落' : item.kind === 'split' ? '内容拆分' : '内容合并'} · 待决定
                      </Badge>
                      <p className="text-[11px] text-slate-500">{item.note}</p>
                      <div className="ml-auto flex gap-2">
                        {item.kind === 'duplicate' && (
                          <Button size="sm" variant="ghost" onClick={() => onSessionChange(resetDuplicateGroup(session, item.id))}>重置配对</Button>
                        )}
                        {item.kind !== 'duplicate' && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => onSessionChange(dismissPending(session, item.id))}>放弃建议（按新增/移除处理）</Button>
                            <Button size="sm" disabled={!canResolve} onClick={() => onSessionChange(item.kind === 'split' ? resolveSplit(session, item.id) : resolveMerge(session, item.id))}><Check className="h-3.5 w-3.5" />确认关系</Button>
                          </>
                        )}
                      </div>
                    </div>

                    {item.kind === 'duplicate' ? (
                      <div className="space-y-3">
                        {newBlocks.map((newBlock) => {
                          const pairedMatch = session.matches.find((match) => match.newSegmentIds.includes(newBlock.id) && match.kind !== 'new')
                          const pairedOld = pairedMatch ? oldById.get(pairedMatch.oldSegmentIds[0] ?? '') : undefined
                          const usedElsewhere = new Set(session.matches.filter((match) => match.kind === 'duplicate' && !match.newSegmentIds.includes(newBlock.id)).flatMap((match) => match.oldSegmentIds))
                          const choices = oldBlocks.filter((block) => !usedElsewhere.has(block.id) || pairedOld?.id === block.id)
                          return (
                            <div key={newBlock.id} className="grid items-start gap-2 md:grid-cols-[1fr_auto_1fr]">
                              <BlockPreview segment={newBlock} tone="new" badge={<Badge className={matchBadgeClass.new}>新块</Badge>} />
                              <div className="flex items-center justify-center md:h-full">
                                <select
                                  aria-label="为该新块选择对应旧块"
                                  className="h-8 max-w-[200px] rounded-md border border-slate-300 bg-white px-2 text-[11px] text-slate-700"
                                  value={pairedOld?.id ?? ''}
                                  onChange={(event) => onSessionChange(setDuplicatePair(session, item.id, newBlock.id, event.target.value || null))}
                                >
                                  <option value="">作为新版新增（不沿用译文）</option>
                                  {choices.map((block) => <option key={block.id} value={block.id}>对应旧块 #{String(block.index).padStart(2, '0')}</option>)}
                                </select>
                              </div>
                              <div className="rounded-lg border border-dashed border-slate-300 p-2.5">
                                {pairedOld
                                  ? <BlockPreview segment={pairedOld} tone="old" badge={<Badge className={matchBadgeClass.duplicate}>沿用此译文</Badge>} />
                                  : <p className="py-3 text-center text-[11px] text-slate-400">未选择旧块，将作为新增内容重新翻译</p>}
                              </div>
                            </div>
                          )
                        })}
                        <p className="text-[10px] text-slate-400">未被任何新块选中的旧块将在确认后自动归档。为每个新块选定旧块后，本项自动完成。</p>
                      </div>
                    ) : (
                      <div className="grid items-start gap-2 md:grid-cols-2">
                        <div className="space-y-2">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">旧版内容{oldBlocks.length > 1 ? `（${oldBlocks.length} 块）` : ''}</p>
                          {oldBlocks.map((block) => (
                            <div key={block.id} className="relative">
                              <BlockPreview segment={block} tone="old" />
                              {item.kind === 'merge' && oldBlocks.length > 1 && (
                                <button aria-label="移除该旧块" className="absolute right-1.5 top-1.5 rounded-full bg-white/90 p-1 text-slate-400 hover:text-red-600" onClick={() => onSessionChange(togglePendingMember(session, item.id, 'old', block.id))}><X className="h-3 w-3" /></button>
                              )}
                            </div>
                          ))}
                          {item.kind === 'merge' && addableOld.length > 0 && (
                            <AddMember options={addableOld} onAdd={(id) => onSessionChange(togglePendingMember(session, item.id, 'old', id))} label="加入旧块" />
                          )}
                        </div>
                        <div className="space-y-2">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-400">新版内容{newBlocks.length > 1 ? `（${newBlocks.length} 块）` : ''}</p>
                          {newBlocks.map((block) => (
                            <div key={block.id} className="relative">
                              <BlockPreview segment={block} tone="new" />
                              {item.kind === 'split' && newBlocks.length > 1 && (
                                <button aria-label="移除该新块" className="absolute right-1.5 top-1.5 rounded-full bg-white/90 p-1 text-slate-400 hover:text-red-600" onClick={() => onSessionChange(togglePendingMember(session, item.id, 'new', block.id))}><X className="h-3 w-3" /></button>
                              )}
                            </div>
                          ))}
                          {item.kind === 'split' && addableNew.length > 0 && (
                            <AddMember options={addableNew} onAdd={(id) => onSessionChange(togglePendingMember(session, item.id, 'new', id))} label="加入新块" />
                          )}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            }) : (
              <div className="grid place-items-center rounded-xl border border-emerald-200 bg-emerald-50 py-16 text-center">
                <Check className="h-8 w-8 text-emerald-600" />
                <p className="mt-3 text-sm font-medium text-emerald-800">所有重复、拆分、合并项都已处理</p>
                <p className="mt-1 text-xs text-emerald-700">可以在上方“完成并应用”，应用后按对应关系恢复译文、讨论与确认状态，旧内容进入归档。</p>
              </div>
            )
          )}

          {tab === 'all' && (
            <div className="space-y-2">
              {resolvedMatches.map((match) => (
                <Card key={match.id} className="shadow-sm">
                  <CardContent className="grid gap-2 p-3 md:grid-cols-2">
                    <div className="space-y-2">
                      {match.oldSegmentIds.map((id) => {
                        const block = oldById.get(id)
                        return block ? <BlockPreview key={id} segment={block} tone="old" badge={<Badge className={matchBadgeClass[match.kind]}>{matchLabel(match.kind)}</Badge>} /> : null
                      })}
                    </div>
                    <div className="relative space-y-2 md:pl-4">
                      <ChevronRight className="absolute -left-1 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-slate-400 md:block" />
                      {match.newSegmentIds.map((id) => {
                        const block = newById.get(id)
                        return block ? <BlockPreview key={id} segment={block} tone="new" badge={match.kind === 'similar' ? <Badge className={matchBadgeClass.similar}>待复核 {Math.round((match.similarity ?? 0) * 100)}%</Badge> : undefined} /> : null
                      })}
                    </div>
                  </CardContent>
                </Card>
              ))}
              {!resolvedMatches.length && <p className="py-12 text-center text-xs text-slate-400">尚无对应关系</p>}
            </div>
          )}

          {tab === 'new' && (
            <div className="grid gap-2 md:grid-cols-2">
              {newMatches.flatMap((match) => match.newSegmentIds).map((id) => {
                const block = newById.get(id)
                return block ? <BlockPreview key={id} segment={block} tone="new" badge={<Badge className={matchBadgeClass.new}>新版新增</Badge>} /> : null
              })}
              {!newMatches.length && <p className="py-12 text-center text-xs text-slate-400">没有新增内容块</p>}
            </div>
          )}

          {tab === 'removed' && (
            <div className="grid gap-2 md:grid-cols-2">
              {removedMatches.flatMap((match) => match.oldSegmentIds).map((id) => {
                const block = oldById.get(id)
                return block ? <BlockPreview key={id} segment={block} tone="old" badge={<Badge className={matchBadgeClass.removed}>将归档</Badge>} /> : null
              })}
              {!removedMatches.length && <p className="py-12 text-center text-xs text-slate-400">没有移除的内容块</p>}
            </div>
          )}
        </div>
      </div>

      <footer className="border-t bg-white px-4 py-2.5 lg:px-6">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-2 text-[11px] text-slate-500">
          <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
          <span>完全相同/移动：直接沿用译文与确认状态</span>
          <span>·</span>
          <span>轻改：沿用译文并标记“待复核”</span>
          <span>·</span>
          <span>移除：译文、讨论与历史归档</span>
          <span>·</span>
          <span>应用后使用当前术语表重新检查</span>
        </div>
      </footer>
    </div>
  )
}

function AddMember({ options, onAdd, label }: { options: Segment[]; onAdd: (id: string) => void; label: string }) {
  const [value, setValue] = useState('')
  return (
    <div className="flex gap-2">
      <select aria-label={label} className="h-8 min-w-0 flex-1 rounded-md border border-dashed border-slate-300 bg-white px-2 text-[11px] text-slate-600" value={value} onChange={(event) => setValue(event.target.value)}>
        <option value="">{label}…</option>
        {options.map((block) => <option key={block.id} value={block.id}>#{String(block.index).padStart(2, '0')} · {block.sourceText.slice(0, 40)}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={!value} onClick={() => { if (value) { onAdd(value); setValue('') } }}>加入</Button>
    </div>
  )
}
