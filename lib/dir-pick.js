/**
 * 系统「选文件夹」窗口 —— 一个**没有任何内部依赖**的模块。
 *
 * ## 为什么单独拆出来
 *
 * 这个能力有两处要用：
 *   · 宿主的设置面板（`lib/settings-routes.js` 的 `/qqai/data-dir/pick`）；
 *   · 独立控制台的首次启动向导（`control/lib/supervisor.mjs` 的 `/api/data-dir/browse`）。
 *
 * 而 `lib/settings-routes.js` 会 import `control/lib/{server,supervisor}.mjs`——
 * 控制台反过来 import 它就成**循环依赖**（ESM 循环在求值顺序上炸，报错位置离真因很远）。
 * 所以把这段"只依赖 node 内置模块"的逻辑单独放一层，两边都从这里取，
 * **规则只有一份**：不会出现"面板能选、控制台选不了"这种分裂。
 *
 * 全部注入化：单测里**绝不能真弹一个窗口**（会挂住自动化，无人值守时直接卡死）。
 */
import { execFile } from 'node:child_process'

/**
 * 从 PowerShell 的输出里挑出被选中的目录。
 *
 * 为什么不能"取最后一行就当路径"：`powershell.exe` 会在正常输出前后夹 CLIXML 警告、
 * 进度条、甚至一行 `#< CLIXML`。取最后一行会把警告当成路径写进配置 ——
 * 那种失败**不报错**，只是以后所有数据都写到某个叫 `#< CLIXML` 的目录里。
 * 所以只认"看起来像绝对路径"的行，挑最后一个。
 *
 * 空串 = 用户取消（脚本在这种情况下**什么都不输出**）。
 */
export function parseFolderDialogOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (/^[A-Za-z]:[\\/]/.test(line) || /^\\\\/.test(line) || /^\//.test(line)) return line
  }
  return ''
}

/**
 * 弹系统选文件夹窗口，返回 `{ok, path}` / `{ok:false, reason}`。
 *
 * `execFileImpl` 可注入：单测里**绝不能真弹一个窗口**（会挂住自动化、也会在无人值守时卡死）。
 */
export function pickFolderDialog({ startDir = '', execFileImpl = execFile, platform = process.platform, description = '' } = {}) {
  return new Promise((resolve) => {
    if (platform !== 'win32') {
      resolve({ ok: false, reason: '这个按钮只在 Windows 上可用；请直接把绝对路径填进「数据根目录」' })
      return
    }
    /**
     * 用环境变量传起始目录，不拼进脚本：路径里有中文/空格/引号时，
     * 字符串拼接会造出一个语法错误的脚本 —— 而那种错误在面板上只表现为"点了没反应"。
     */
    const title = description || '选择数据根目录（记忆 / 聊天记录 / 收发文件都放这里）'
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = $env:QQAI_PICK_TITLE`,
      '$d.ShowNewFolderButton = $true',
      'if ($env:QQAI_PICK_START -and (Test-Path -LiteralPath $env:QQAI_PICK_START)) { $d.SelectedPath = $env:QQAI_PICK_START }',
      '$r = $d.ShowDialog()',
      'if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($d.SelectedPath) }',
      '$d.Dispose()',
    ].join('; ')
    execFileImpl(
      'powershell.exe',
      ['-STA', '-NoProfile', '-Command', script],
      {
        timeout: 180000,
        windowsHide: true,
        env: { ...process.env, QQAI_PICK_START: String(startDir ?? ''), QQAI_PICK_TITLE: title },
      },
      (error, stdout) => {
        if (error) {
          // 超时/被杀：说清是"没等到你选"，而不是"路径非法"
          const timedOut = error.killed === true || error.signal === 'SIGTERM'
          resolve({
            ok: false,
            reason: timedOut
              ? '选文件夹窗口超时（3 分钟没选）——已取消，配置一个字都没改'
              : `打不开选文件夹窗口：${error.message}`,
          })
          return
        }
        const picked = parseFolderDialogOutput(stdout)
        resolve(picked === ''
          ? { ok: false, reason: '没有选择目录（窗口被取消或直接关掉了），配置一个字都没改' }
          : { ok: true, path: picked })
      },
    )
  })
}
