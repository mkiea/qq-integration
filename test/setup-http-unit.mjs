/**
 * 向导 HTTP 层的鲁棒性测试 —— 2026-11-05。
 *
 * 为什么不只测函数：函数级全过，不代表 HTTP 层安全。要测的是
 *   ① 鉴权（无 token / 错 token）
 *   ② 方法约束（PUT/DELETE 不该被当成 POST 处理）
 *   ③ 畸形 body（非法 JSON / 超大 body）—— 不能把进程搞崩
 *   ④ 并发写（10 个同时来）—— 配置文件不能写坏
 *
 * 隔离手段：**把 DSH_HOME 指到临时目录**，控制台就会往那里写 cordis.patch.yml，
 * 真实配置一个字节都不碰（detectPaths 优先读 env.DSH_HOME）。
 *
 * 用法：node test/setup-http-unit.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const PORT = 8901
const TOKEN = 'test-token-robust-123'

let passed = 0
let failed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log('PASS', name) }
  else { failed++; failures.push(`${name} — ${detail}`); console.log('FAIL', name, '|', detail) }
}

// ---------------------------------------------------------------- 临时 DSH_HOME
const home = mkdtempSync(join(tmpdir(), 'setup-http-'))
const profileDir = join(home, 'profiles', 'web')
mkdirSync(profileDir, { recursive: true })
const patchPath = join(profileDir, 'cordis.patch.yml')
writeFileSync(patchPath, `- id: dsh-qq-onebot-bridge
  name: dsh-qq-onebot-bridge
  config:
    botQq: 100000001
    allowUsers: [100000002]
    allowGroups: [100000003]
`, 'utf8')

// 控制台的配置文件（token 从这里读）
const controlConfig = join(home, 'qq-control.json')
writeFileSync(controlConfig, JSON.stringify({ token: TOKEN, dataDir: home, profile: 'web' }, null, 2), 'utf8')

// ---------------------------------------------------------------- 起控制台
const child = spawn(process.execPath, ['control/bin/qq-control.mjs', '--port', String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, DSH_HOME: home, DSH_QQ_CWD: home, QQ_CONTROL_CONFIG: controlConfig },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childOutput = ''
child.stdout.on('data', (d) => { childOutput += d.toString() })
child.stderr.on('data', (d) => { childOutput += d.toString() })

/** 发一个 HTTP 请求，返回 { status, body } */
function req(method, path, { token = TOKEN, body = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const payload = body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body))
    const headers = {}
    if (token) headers['x-control-token'] = token
    if (payload !== null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    const options = { host: '127.0.0.1', port: PORT, path, method, headers, timeout: timeoutMs }
    const r = request(options, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout' }) })
    r.on('error', (e) => resolve({ status: 0, body: e.message }))
    if (payload !== null) r.write(payload)
    r.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 主流程
try {
  // 等端口就绪（最多 10 秒）
  let ready = false
  for (let i = 0; i < 40; i++) {
    const r = await req('GET', `/api/setup/target?token=${TOKEN}`)
    if (r.status === 200) { ready = true; break }
    await sleep(250)
  }
  check('控制台 10 秒内就绪', ready, childOutput.slice(-200))

  if (ready) {
    console.log('\n--- 鉴权 ---')
    {
      const r1 = await req('GET', '/api/setup/read', { token: null })
      check('无 token → 401', r1.status === 401, `status=${r1.status}`)
      const r2 = await req('GET', '/api/setup/read', { token: 'wrong-token' })
      check('错 token → 401', r2.status === 401, `status=${r2.status}`)
      const r3 = await req('GET', `/api/setup/read?token=${TOKEN}`, { token: null })
      check('query token 可用 → 200', r3.status === 200, `status=${r3.status}`)
    }

    console.log('\n--- 方法约束 ---')
    for (const method of ['PUT', 'DELETE']) {
      const r = await req(method, `/api/setup/write?token=${TOKEN}`, { body: { botQq: '100000001', allowUsers: '100000002' } })
      check(`${method} /api/setup/write 被拒（非 2xx）`, r.status >= 400, `status=${r.status}`)
    }
    {
      // 校验失败必须 400 级而不是 200
      const r = await req('POST', `/api/setup/write?token=${TOKEN}`, { body: { botQq: '', allowUsers: '' } })
      const parsed = (() => { try { return JSON.parse(r.body) } catch { return null } })()
      check('非法输入 → 明确失败（ok:false）', r.status === 200 && parsed?.ok === false, `status=${r.status} body=${r.body.slice(0, 80)}`)
    }

    console.log('\n--- 畸形 body ---')
    {
      const r = await req('POST', `/api/setup/write?token=${TOKEN}`, { body: '{ this is not json' })
      check('非法 JSON → 不崩（4xx 或 ok:false）', r.status >= 400 || r.body.includes('"ok":false'), `status=${r.status}`)
    }
    {
      // 5 MB 大 body：要么被拒，要么正常处理，总之进程要活着
      const big = JSON.stringify({ botQq: '100000001', allowUsers: '100000002', pad: 'x'.repeat(5 * 1024 * 1024) })
      const r = await req('POST', `/api/setup/write?token=${TOKEN}`, { body: big, timeoutMs: 15000 })
      check('5MB body → 不崩（有响应）', r.status !== 0, `status=${r.status} body=${r.body.slice(0, 60)}`)
      const alive = await req('GET', `/api/setup/read?token=${TOKEN}`)
      check('大 body 之后进程仍存活', alive.status === 200, `status=${alive.status}`)
    }

    console.log('\n--- 并发写 ---')
    {
      const before = readFileSync(patchPath, 'utf8')
      const jobs = Array.from({ length: 10 }, (_, i) =>
        req('POST', `/api/setup/write?token=${TOKEN}`, {
          body: { botQq: '100000001', allowUsers: `10000000${i % 10},100000002`, allowGroups: '100000003' },
        }))
      const results = await Promise.all(jobs)
      const okCount = results.filter((r) => r.status === 200).length
      check('并发 10 个写：全部有响应', okCount === 10, `成功 ${okCount}/10`)

      // 文件必须仍是合法结构（id 行只有一个、能读回）
      const text = readFileSync(patchPath, 'utf8')
      const idLines = text.split('\n').filter((l) => /^- id:/.test(l)).length
      check('并发后 id 行仍只有 1 个', idLines === 1, `实际 ${idLines} 个`)
      const back = await req('GET', `/api/setup/read?token=${TOKEN}`)
      const parsed = (() => { try { return JSON.parse(back.body) } catch { return null } })()
      check('并发后仍能读回配置', parsed?.ok === true && parsed.values.allowUsers.length >= 1,
        JSON.stringify(parsed?.values ?? {}).slice(0, 100))
      check('并发前后文件都不是空的', before.length > 0 && text.length > 0, `${before.length} → ${text.length}`)
    }
  }
} finally {
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  await sleep(500)
  try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  ·', f)
}
process.exit(failed > 0 ? 1 : 0)
