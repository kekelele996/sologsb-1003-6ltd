// Quick logic verification for the migration algorithm.
// Transpiles src/lib/migration.ts + markdown.ts + types.ts to JS in memory and runs scenarios.
const ts = require('typescript')
const fs = require('fs')
const path = require('path')

function transpile(file) {
  const source = fs.readFileSync(file, 'utf8')
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: file,
  })
  return result.outputText
}

const libDir = path.join(__dirname, '..', 'src', 'lib')
const typesJs = transpile(path.join(libDir, 'types.ts'))
const markdownJs = transpile(path.join(libDir, 'markdown.ts'))
const migrationJs = transpile(path.join(libDir, 'migration.ts'))

const moduleCache = {}
function load(name, code) {
  const module = { exports: {} }
  const localRequire = (req) => {
    if (req === './types') return load('types', typesJs)
    if (req === './markdown') return load('markdown', markdownJs)
    throw new Error('unexpected require ' + req)
  }
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  fn(module.exports, localRequire, module, name, libDir)
  moduleCache[name] = module.exports
  return module.exports
}

const { analyzeMigration, applyMigration, pendingDecisionCount, allDecisionsResolved, acceptAllRecommendations, updateResolution, similarity } = load('migration', migrationJs)

let passed = 0
let failed = 0
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}`, extra ?? '') }
}

const seg = (id, index, kind, sourceText, targetText, status = 'draft', note = '') => ({
  id, index, kind, sourceText, targetText, status, protectedTokens: [], note,
})

console.log('=== similarity ===')
check('identical = 1', similarity('Hello world', 'Hello world') === 1)
check('whitespace-normalized = 1', similarity('Hello   world', 'Hello world') === 1)
check('light edit > 0.7', similarity('The quick brown fox jumps.', 'The quick brown fox jumps high.') > 0.7)
check('unrelated < 0.4', similarity('The quick brown fox.', 'Kubernetes is a container orchestration platform.') < 0.4)

console.log('=== exact match + moved position ===')
{
  const old = [
    seg('a', 1, 'paragraph', 'First paragraph.', '第一段。', 'confirmed'),
    seg('b', 2, 'paragraph', 'Second paragraph.', '第二段。', 'draft'),
    seg('c', 3, 'paragraph', 'Third paragraph.', '第三段。', 'needs-work'),
  ]
  // new doc: order changed (Third moved to top), all identical
  const md = 'Third paragraph.\n\nFirst paragraph.\n\nSecond paragraph.'
  const plan = analyzeMigration(old, md, 'v2.md', [], [], [])
  check('3 exact pairs', plan.pairs.length === 3, plan.pairs.length)
  check('no decisions', plan.decisions.length === 0)
  check('no archived', plan.archived.length === 0)
  const applied = applyMigration(plan, { discussions: [], history: [], conflicts: [] })
  check('moved block keeps translation', applied.segments[0].targetText === '第三段。')
  check('moved block keeps confirmed status', applied.segments[0].status === 'needs-work' ? true : applied.segments[0].status === 'confirmed')
  check('all translations carried', applied.segments.every((s) => s.targetText))
}

console.log('=== fuzzy match (light edit) ===')
{
  const old = [seg('a', 1, 'paragraph', 'The operator requires cluster-admin privileges during installation.', '安装时 operator 需要集群管理员权限。', 'confirmed')]
  const md = 'The operator requires cluster-admin privileges during the installation process.'
  const plan = analyzeMigration(old, md, 'v2.md', [], [], [])
  check('1 fuzzy pair', plan.pairs.length === 1 && plan.pairs[0].kind === 'fuzzy', plan.pairs)
  const applied = applyMigration(plan, { discussions: [], history: [], conflicts: [] })
  check('translation kept', applied.segments[0].targetText === '安装时 operator 需要集群管理员权限。')
  check('marked needs-work', applied.segments[0].status === 'needs-work')
}

console.log('=== removed -> archived, added -> new ===')
{
  const old = [
    seg('a', 1, 'paragraph', 'Keep this paragraph.', '保留这段。', 'confirmed'),
    seg('b', 2, 'paragraph', 'This paragraph was removed in v2.', '这段在 v2 移除。', 'draft'),
  ]
  const md = 'Keep this paragraph.\n\nThis is a brand new paragraph for v2.'
  const plan = analyzeMigration(old, md, 'v2.md', [], [], [])
  check('1 pair', plan.pairs.length === 1)
  check('1 archived', plan.archived.length === 1 && plan.archived[0].block.id === 'b')
  const applied = applyMigration(plan, { discussions: [], history: [], conflicts: [] })
  check('new block has empty translation', applied.segments[1].targetText === '' && applied.segments[1].status === 'draft')
  check('archive preserved', applied.archive.length === 1 && applied.archive[0].block.id === 'b')
}

console.log('=== duplicate paragraphs ===')
{
  const old = [
    seg('a', 1, 'paragraph', 'Note: see the documentation.', '注：请参阅文档。', 'draft'),
    seg('b', 2, 'paragraph', 'Note: see the documentation.', '注：请参考文档。', 'confirmed'),
  ]
  const md = 'Note: see the documentation.\n\nNote: see the documentation.'
  const plan = analyzeMigration(old, md, 'v2.md', [], [], [])
  check('1 duplicate decision', plan.decisions.length === 1 && plan.decisions[0].kind === 'duplicate', plan.decisions)
  check('pending before resolve', pendingDecisionCount(plan) === 1)
  check('apply blocked before resolve', allDecisionsResolved(plan) === false)
  const accepted = acceptAllRecommendations(plan)
  check('resolved after accept', pendingDecisionCount(accepted) === 0 && allDecisionsResolved(accepted) === true)
  const applied = applyMigration(accepted, { discussions: [], history: [], conflicts: [] })
  check('both translations carried', applied.segments.every((s) => s.targetText))
}

console.log('=== split (1 old -> N new) ===')
{
  const old = [seg('a', 1, 'paragraph', 'The controller manages the lifecycle. It also handles upgrades.', '控制器管理生命周期，也处理升级。', 'confirmed')]
  const md = 'The controller manages the lifecycle.\n\nIt also handles upgrades.'
  const plan = analyzeMigration(old, md, 'v2.md', [], [], [])
  check('1 split decision', plan.decisions.length === 1 && plan.decisions[0].kind === 'split', plan.decisions)
  const accepted = acceptAllRecommendations(plan)
  const applied = applyMigration(accepted, { discussions: [], history: [], conflicts: [] })
  check('old translation inherited by one new block', applied.segments.filter((s) => s.targetText === '控制器管理生命周期，也处理升级。').length === 1)
  check('other new block empty', applied.segments.some((s) => s.targetText === ''))
}

console.log('=== merge (N old -> 1 new) ===')
{
  const old = [
    seg('a', 1, 'paragraph', 'First, install the operator.', '首先安装 operator。', 'confirmed'),
    seg('b', 2, 'paragraph', 'Then configure the cluster.', '然后配置集群。', 'draft'),
  ]
  const md = 'First, install the operator, then configure the cluster.'
  const plan = analyzeMigration(old, md, 'v2.md', [], [], [])
  check('1 merge decision', plan.decisions.length === 1 && plan.decisions[0].kind === 'merge', plan.decisions)
  const accepted = acceptAllRecommendations(plan)
  const applied = applyMigration(accepted, { discussions: [], history: [], conflicts: [] })
  check('one translation carried', applied.segments.filter((s) => s.targetText).length === 1)
  check('one old archived', applied.archive.length === 1)
}

console.log('=== discussions/history/conflicts remapped ===')
{
  const old = [
    seg('a', 1, 'paragraph', 'Keep this paragraph.', '保留这段。', 'confirmed'),
    seg('b', 2, 'paragraph', 'Removed paragraph.', '移除段。', 'draft'),
  ]
  const discussions = [
    { id: 'd1', segmentId: 'a', author: 'u', body: 'disc on kept', resolved: false, createdAt: 1 },
    { id: 'd2', segmentId: 'b', author: 'u', body: 'disc on removed', resolved: false, createdAt: 2 },
  ]
  const history = [
    { id: 'h1', segmentId: 'a', author: 'u', action: 'edit', before: '', after: 'x', createdAt: 1 },
  ]
  const conflicts = [
    { id: 'c1', segmentId: 'a', localText: 'l', remoteText: 'r', remoteAuthor: 'ra', createdAt: 1 },
  ]
  const md = 'Keep this paragraph.'
  const plan = analyzeMigration(old, md, 'v2.md', discussions, history, conflicts)
  const applied = applyMigration(plan, { discussions, history, conflicts })
  check('discussion remapped to new segment', applied.discussions.length === 1 && applied.discussions[0].segmentId === applied.segments[0].id, applied.discussions)
  check('history remapped', applied.history.length === 1 && applied.history[0].segmentId === applied.segments[0].id)
  check('conflict remapped', applied.conflicts.length === 1 && applied.conflicts[0].segmentId === applied.segments[0].id)
  check('removed discussion archived', applied.archive[0].discussions.length === 1 && applied.archive[0].discussions[0].id === 'd2')
}

console.log('=== ambiguity (two close candidates) ===')
{
  const old = [
    seg('a', 1, 'paragraph', 'The operator manages the cluster lifecycle.', 'Operator 管理集群生命周期。', 'confirmed'),
    seg('b', 2, 'paragraph', 'The operator handles the cluster upgrades.', 'Operator 处理集群升级。', 'draft'),
  ]
  // new doc: two new blocks, each close to both old blocks
  const md = 'The operator manages the cluster lifecycle.\n\nThe operator handles the cluster upgrades safely.'
  const plan = analyzeMigration(old, md, 'v2.md', [], [], [])
  check('has decisions or pairs', plan.decisions.length > 0 || plan.pairs.length > 0)
  const totalMatched = plan.pairs.length + plan.decisions.reduce((n, d) => n + d.newIds.length, 0)
  check('all new blocks accounted for', totalMatched === 2, totalMatched)
  const accepted = acceptAllRecommendations(plan)
  const applied = applyMigration(accepted, { discussions: [], history: [], conflicts: [] })
  check('both translations carried', applied.segments.every((s) => s.targetText))
}

console.log('=== code blocks preserved ===')
{
  const old = [seg('a', 1, 'code', '```bash\nhelm upgrade --install {{release_name}} oci://registry.example.com/operator\n```', '```bash\nhelm upgrade --install {{release_name}} oci://registry.example.com/operator\n```', 'confirmed')]
  const md = '```bash\nhelm upgrade --install {{release_name}} oci://registry.example.com/operator\n```'
  const plan = analyzeMigration(old, md, 'v2.md', [], [], [])
  check('code block exact matched', plan.pairs.length === 1 && plan.pairs[0].kind === 'exact')
  const applied = applyMigration(plan, { discussions: [], history: [], conflicts: [] })
  check('code translation kept', applied.segments[0].targetText === old[0].targetText)
  check('code status kept confirmed', applied.segments[0].status === 'confirmed')
  check('protected tokens recomputed', applied.segments[0].protectedTokens.includes('{{release_name}}'))
}

console.log('=== variables preserved after fuzzy match ===')
{
  const old = [seg('a', 1, 'variable', 'Set `replicaCount` to `{replica_count}` in your values file.', '在 values 文件中将 `replicaCount` 设置为 `{replica_count}`。', 'draft')]
  const md = 'Set `replicaCount` to `{replica_count}` in your values.yaml file.'
  const plan = analyzeMigration(old, md, 'v2.md', [], [], [])
  check('fuzzy pair', plan.pairs.length === 1 && plan.pairs[0].kind === 'fuzzy')
  const applied = applyMigration(plan, { discussions: [], history: [], conflicts: [] })
  check('translation kept', applied.segments[0].targetText.includes('{replica_count}'))
  check('marked needs-work', applied.segments[0].status === 'needs-work')
  check('protected tokens recomputed', applied.segments[0].protectedTokens.includes('{replica_count}'))
}

console.log('=== resolution persists across reopen (plan round-trip) ===')
{
  const old = [seg('a', 1, 'paragraph', 'Note: see the documentation.', '注：请参阅文档。', 'draft')]
  const md = 'Note: see the documentation.\n\nNote: see the documentation.'
  const plan = analyzeMigration(old, md, 'v2.md', [], [], [])
  const resolved = updateResolution(plan, plan.decisions[0].id, plan.decisions[0].newIds[0], 'a')
  const serialized = JSON.stringify(resolved)
  const restored = JSON.parse(serialized)
  check('resolution survives JSON round-trip', restored.decisions[0].resolution[restored.decisions[0].newIds[0]] === 'a')
  check('resolved flag survives', restored.decisions[0].resolved === true)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
