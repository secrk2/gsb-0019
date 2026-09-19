// 三个线上 bug 的端到端回归：
//  1. 代理人/客户同时改同一份交底：不同段落自动合并不丢段，同段双改才弹取舍且明示段落；
//  2. 脱敏规则调整后，已发给客户的历史版本仍按该版快照渲染（前后两次打开一致）；
//  3. 定稿附件换版后，从旧版本点进去下载的仍是旧原件（不可变 key）。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { boot, login } from './helpers.js'

let server
let base
const T = {}
const shared = {} // 跨用例复用本文件内创建的撰稿链 id

async function asUser(username) {
  const token = T[username] || (T[username] = await login(base, username))
  return async (method, path, body, headers = {}) => {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const j = await r.json().catch(() => null)
    return { status: r.status, body: j, headers: r.headers }
  }
}

const content = (sections) => ({ sections: Object.entries(sections).map(([key, paras]) => ({ key, paragraphs: paras.map(([id, text]) => ({ id, text })) })) })

before(async () => {
  ;({ server, base } = await boot())
})
after(() => server.close())

test('协同不同段：双方各改各的段，后保存者不丢对方段落，且返回自动并入明细', async () => {
  const client = await asUser('client01')
  const agent = await asUser('agent01')
  const created = await client('POST', '/cases/3/writing/disclosure', { title: '回归-并发不同段' })
  assert.equal(created.status, 201)
  const docId = created.body.data.id
  shared.case3DisclosureDocId = docId

  const v1 = await client('POST', '/cases/3/writing/disclosure/save', {
    content: content({
      solution: [['s1', '客户段一 HX-77A'], ['s2', '客户段二原文']],
      effect: [['e1', '效果段，双方都不改']],
    }),
    summary: '客户初稿',
  })
  assert.equal(v1.status, 201)

  // 代理人基于 v1：只改 s2，新增 a1
  const v2 = await agent('POST', '/cases/3/writing/disclosure/save', {
    base_version_id: v1.body.data.version_id,
    content: content({
      solution: [['s1', '客户段一 HX-77A'], ['s2', '代理人改写的段二'], ['a1', '代理人补充实施例']],
      effect: [['e1', '效果段，双方都不改']],
    }),
  })
  assert.equal(v2.status, 201)
  assert.equal(v2.body.data.version_no, 2)

  // 客户仍基于 v1：只改 s1，不动 s2/a1
  const v3 = await client('POST', '/cases/3/writing/disclosure/save', {
    base_version_id: v1.body.data.version_id,
    content: content({
      solution: [['s1', '客户改写的段一 HX-77A'], ['s2', '客户段二原文']],
      effect: [['e1', '效果段，双方都不改']],
    }),
  })
  assert.equal(v3.status, 201, '不同段并发应自动合并成功，而不是 409 或静默覆盖')
  assert.equal(v3.body.data.version_no, 3)
  assert.ok(v3.body.data.branched)
  assert.ok(v3.body.data.auto_merged >= 2, `自动并入数应 >= 2，实际 ${v3.body.data.auto_merged}`)
  // 合并提示明示了哪些段落来自对方
  const mergedIds = v3.body.data.auto_merged_paragraphs.map((d) => d.paragraph_id)
  assert.ok(mergedIds.includes('s2'), '应提示并入了代理人改写的 s2')
  assert.ok(mergedIds.includes('a1'), '应提示并入了代理人新增的 a1')

  // 链头 v3：双方改动都在，没有任何一段丢失
  const head = (await agent('GET', `/writing/docs/${docId}`)).body.data.head.content
  const sol = new Map(head.sections.find((s) => s.key === 'solution').paragraphs.map((p) => [p.id, p.text]))
  assert.equal(sol.get('s1'), '客户改写的段一 HX-77A', '客户改的段保留')
  assert.equal(sol.get('s2'), '代理人改写的段二', '代理人改的段未被后来者旧副本覆盖')
  assert.equal(sol.get('a1'), '代理人补充实施例', '代理人新增段未丢')
  assert.equal(head.sections.find((s) => s.key === 'effect').paragraphs[0].text, '效果段，双方都不改')

  // 反向再来一次：这次代理人是后来者，同样不得丢客户段落（旧代码对所有交叉并发都不弹冲突直接覆盖）
  const v4 = await client('POST', '/cases/3/writing/disclosure/save', {
    base_version_id: v3.body.data.version_id,
    content: content({
      solution: [['s1', '客户再次改写段一'], ['s2', '代理人改写的段二'], ['a1', '代理人补充实施例']],
      effect: [['e1', '效果段，双方都不改']],
    }),
  })
  assert.equal(v4.status, 201)
  const v5 = await agent('POST', '/cases/3/writing/disclosure/save', {
    base_version_id: v3.body.data.version_id,
    content: content({
      solution: [['s1', '客户改写的段一 HX-77A'], ['s2', '代理人改写的段二'], ['a1', '代理人补充实施例'], ['a2', '代理人再补一段']],
      effect: [['e1', '效果段，双方都不改']],
    }),
  })
  assert.equal(v5.status, 201)
  const head2 = (await client('GET', `/writing/docs/${docId}`)).body.data.head.content
  const sol2 = new Map(head2.sections.find((s) => s.key === 'solution').paragraphs.map((p) => [p.id, p.text]))
  assert.equal(sol2.get('s1'), '客户再次改写段一', '代理人后来保存不得覆盖客户段落')
  assert.ok(sol2.has('a2'), '代理人新增段保留')
})

test('协同同段：双方改同一段仍弹逐段取舍，明确给出被覆盖风险段落', async () => {
  const client = await asUser('client03')
  const agent = await asUser('agent01')
  const created = await client('POST', '/cases/9/writing/disclosure', { title: '回归-并发同段' })
  const docId = created.body.data.id
  const v1 = await client('POST', '/cases/9/writing/disclosure/save', { content: content({ solution: [['x1', '共同原文']] }) })
  const v2 = await agent('POST', '/cases/9/writing/disclosure/save', {
    base_version_id: v1.body.data.version_id,
    content: content({ solution: [['x1', '代理人版本']] }),
  })
  assert.equal(v2.status, 201)
  const conflict = await client('POST', '/cases/9/writing/disclosure/save', {
    base_version_id: v1.body.data.version_id,
    content: content({ solution: [['x1', '客户版本']] }),
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'PARAGRAPH_CONFLICT')
  assert.equal(conflict.body.error.details.conflicts.length, 1)
  assert.equal(conflict.body.error.details.conflicts[0].paragraph_id, 'x1')
  void docId
})

test('规则升级：已发历史版本两次打开内容一致，始终按该版 v1 快照渲染', async () => {
  const client = await asUser('client01')
  const admin = await asUser('admin')
  const overview = (await client('GET', '/cases/3/writing')).body.data
  const docId = overview.kinds.disclosure.doc.id // 「回归-并发不同段」链

  // 发布 v2：新增 HX 代号遮蔽
  const rules = (await admin('GET', '/writing/mask-rules')).body.data
  const published = await admin('POST', '/writing/mask-rules', {
    note: '回归 v2',
    rules: {
      hideSections: rules.rules.hideSections,
      hideSensitiveParagraphs: true,
      patterns: [...rules.rules.patterns, { id: 'hx', name: '产线代号', regex: 'HX-\\d+[A-Z]?', replacement: '【代号】', flags: 'g' }],
    },
  })
  assert.equal(published.status, 201)

  const detail = (await client('GET', `/writing/docs/${docId}`)).body.data
  const v1row = detail.versions.find((v) => v.version_no === 1)
  const open1 = (await client('GET', `/writing/versions/${v1row.id}`)).body.data.version
  const open2 = (await client('GET', `/writing/versions/${v1row.id}`)).body.data.version
  assert.equal(open1.mask_rule_version, 1, '历史版本标记的规则版本仍为 v1')
  assert.equal(open2.mask_rule_version, 1)
  const t1 = open1.content.sections.find((s) => s.key === 'solution').paragraphs.find((p) => p.id === 's1').text
  const t2 = open2.content.sections.find((s) => s.key === 'solution').paragraphs.find((p) => p.id === 's1').text
  assert.equal(t1, t2, '同一份历史版本前后两次打开必须完全一致')
  assert.match(t1, /HX-77A/, 'v1 快照不遮蔽 HX 代号')
  assert.doesNotMatch(t1, /【代号】/)

  // v2 之后保存的新版本才按 v2 渲染
  const headId = detail.head_version_id
  const saved = await client('POST', '/cases/3/writing/disclosure/save', {
    base_version_id: headId,
    content: content({ solution: [['s1', '客户在 v2 规则下补充：对应 HX-77A 的工艺窗口'], ['s2', '代理人改写的段二'], ['a1', '代理人补充实施例'], ['a2', '代理人再补一段']], effect: [['e1', '效果段，双方都不改']] }),
  })
  assert.equal(saved.status, 201)
  const newHead = (await client('GET', `/writing/versions/${saved.body.data.version_id}`)).body.data.version
  assert.equal(newHead.mask_rule_version, 2)
})

test('附件换版：旧版本点进去仍下载旧原件，无版本号时才取当前版', async () => {
  const agent = await asUser('agent01')
  const client = await asUser('client01') // 回归交底链在案件 3（华芯，client01）
  const targetDocId = shared.case3DisclosureDocId
  const init = await agent('POST', `/writing/docs/${targetDocId}/attachments/init`, { filename: '回归附件.pdf', content_type: 'application/pdf' })
  assert.equal(init.status, 201)
  const attId = init.body.data.attachment_id
  async function upload(versionId, token, bytes, who = 'agent01') {
    return fetch(`${base}/api/writing/attachments/upload/${versionId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${T[who]}`, 'X-Upload-Token': token, 'Content-Type': 'application/pdf' },
      body: Buffer.from(bytes),
    })
  }
  const up1 = await upload(init.body.data.version_id, init.body.data.upload_token, 'OLD-原件-v1-不可变')
  assert.equal(up1.status, 201)

  const init2 = await agent('POST', `/writing/docs/${targetDocId}/attachments/init`, { attachment_id: attId, filename: '回归附件.pdf' })
  const up2 = await upload(init2.body.data.version_id, init2.body.data.upload_token, 'NEW-新版-v2')
  assert.equal(up2.status, 201)

  async function download(version, who = 'agent01') {
    const r = await fetch(`${base}/api/writing/attachments/${attId}/download${version != null ? `?version=${version}` : ''}`, {
      headers: { Authorization: `Bearer ${T[who]}` },
    })
    return { status: r.status, text: await r.text(), ver: r.headers.get('X-Attachment-Version') }
  }
  // 旧版本必须取到旧字节
  const old = await download(1)
  assert.equal(old.status, 200)
  assert.equal(old.ver, '1')
  assert.equal(old.text, 'OLD-原件-v1-不可变')
  // 再点一次旧版（复现「旧原件打不开/打开的是新文件」）
  const oldAgain = await download(1)
  assert.equal(oldAgain.text, 'OLD-原件-v1-不可变')
  // 新版与缺省（当前版）取新字节
  assert.equal((await download(2)).text, 'NEW-新版-v2')
  const cur = await download(undefined)
  assert.equal(cur.ver, '2')
  assert.equal(cur.text, 'NEW-新版-v2')
  // 客户从交底书附件旧版点进去同样拿到旧原件
  const oldClient = await download(1, 'client01')
  assert.equal(oldClient.status, 200)
  assert.equal(oldClient.text, 'OLD-原件-v1-不可变')
  // 不存在的版本号给 404，而不是静默回退到当前版
  assert.equal((await download(99)).status, 404)
})
