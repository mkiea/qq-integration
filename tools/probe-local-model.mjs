/**
 * 本地 Ollama 接入体检：能不能用、快不快、支不支持工具调用、中文人设守不守。
 *
 * 判据为什么是这几条：
 *   · 走的是 OpenAI 兼容接口（dsh-llm-pi-ai 的 api: openai-completions），
 *     所以只要 /v1/chat/completions 通，接线本身就不是问题；
 *   · **工具调用是硬门槛** —— DSH agent 靠它发文件/看图/查群，不支持就只剩聊天；
 *   · 速度按 completion_tokens / 秒 算，不是按墙上时间估（含首 token 等待会把小模型算得很难看）。
 */
const BASE = 'http://127.0.0.1:11434/v1'

async function chat(model, messages, extra = {}, timeoutMs = 180_000) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, ...extra }),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) return { ok: false, ms: Date.now() - started, error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    const json = JSON.parse(text)
    return { ok: true, ms: Date.now() - started, json }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

const MODELS = process.argv.slice(2)
if (MODELS.length === 0) {
  console.log('用法: node probe-local-model.mjs <model1> [model2 ...]')
  process.exit(1)
}

for (const model of MODELS) {
  console.log(`\n${'='.repeat(60)}\n模型 ${model}`)

  // ① 预热 + 中文短回复
  const warm = await chat(model, [
    { role: 'system', content: '你是一个说中文的傲娇猫娘，说话短、带点别扭。' },
    { role: 'user', content: '在吗' },
  ], { max_tokens: 80 })
  if (!warm.ok) { console.log('  ✗ 基础对话失败：', warm.error); continue }
  const u1 = warm.json.usage ?? {}
  const reply1 = warm.json.choices?.[0]?.message?.content ?? ''
  const tps1 = u1.completion_tokens ? (u1.completion_tokens / (warm.ms / 1000)).toFixed(1) : '?'
  console.log(`  ① 基础对话 ok  ${warm.ms}ms  ${u1.completion_tokens ?? '?'} tok  ${tps1} tok/s`)
  console.log(`     回复: ${JSON.stringify(reply1.slice(0, 90))}`)

  // ② 工具调用（硬门槛）
  const toolDef = [{
    type: 'function',
    function: {
      name: 'send_file',
      description: '把一个本地文件发给当前聊天对象',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要发送的文件的绝对路径' },
          reason: { type: 'string', description: '为什么要发这个文件' },
        },
        required: ['path'],
      },
    },
  }]
  const tool = await chat(model, [
    { role: 'system', content: '你可以调用工具。' },
    { role: 'user', content: '把 <数据目录>/notes.txt 发给我' },
  ], { tools: toolDef })
  if (!tool.ok) {
    console.log('  ② 工具调用 ✗ 请求失败：', tool.error)
  } else {
    const msg = tool.json.choices?.[0]?.message ?? {}
    const calls = msg.tool_calls ?? []
    if (calls.length > 0) {
      const fn = calls[0].function ?? {}
      let argsOk = false
      try { argsOk = String(JSON.parse(fn.arguments ?? '{}').path ?? '').includes('notes.txt') } catch {}
      console.log(`  ② 工具调用 ✓ ${calls.length} 个调用  fn=${fn.name}  args 解析=${argsOk ? 'ok' : 'bad'}`)
      console.log(`     arguments: ${String(fn.arguments ?? '').slice(0, 140)}`)
    } else {
      console.log('  ② 工具调用 ✗ 没有 tool_calls（这个模型不能当 agent 用）')
      console.log(`     返回内容: ${JSON.stringify(String(msg.content ?? '').slice(0, 160))}`)
    }
  }

  // ③ 多段短回复（她的人设是多条短句）
  const multi = await chat(model, [
    { role: 'system', content: '你是傲娇猫娘凛。用 2-3 条很短的话回，每条不超过 15 字，用换行分隔。别说教、别解释自己。' },
    { role: 'user', content: '今天好累啊' },
  ], { max_tokens: 200 })
  if (multi.ok) {
    const u3 = multi.json.usage ?? {}
    const reply3 = String(multi.json.choices?.[0]?.message?.content ?? '')
    const tps3 = u3.completion_tokens ? (u3.completion_tokens / (multi.ms / 1000)).toFixed(1) : '?'
    const lines = reply3.split('\n').filter((line) => line.trim() !== '')
    const longest = Math.max(0, ...lines.map((line) => line.trim().length))
    console.log(`  ③ 多段短句  ${multi.ms}ms  ${u3.completion_tokens ?? '?'} tok  ${tps3} tok/s  段数=${lines.length} 最长=${longest}字`)
    console.log(`     ${JSON.stringify(reply3.slice(0, 160))}`)
  } else {
    console.log('  ③ 多段短句 ✗', multi.error)
  }
}
