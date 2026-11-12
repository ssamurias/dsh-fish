// 发布前最后一道：核对 `npm pack` 到底装了什么。
//
// 起因（2026-11-13）：README 三处教用户跑 `node tools/check-install.mjs`，
// 但 `package.json` 的 `files` 白名单里没有 `tools/`，装出去的人手里根本没有这个脚本。
// 这种错只有人记得手动跑 `npm pack --dry-run` 才看得见，所以放进 CI 变红。
//
// 跑法：node .github/pack-check.mjs   （零依赖，任意平台）
import { execFileSync } from 'node:child_process';

// Windows 上 npm 是 .cmd，Node 20+ 不许直接 spawn（EINVAL），经 cmd.exe 起一次。
// （不用 shell:true —— 那样会触发 DEP0190，而且没必要开一个 shell。）
const win = process.platform === 'win32';
const out = win
  ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm pack --dry-run --json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  : execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
const [info] = JSON.parse(out);
if (!info || !Array.isArray(info.files)) throw new Error('npm pack --json 的输出里没有 files');

const files = info.files.map((f) => String(f.path).replace(/\\/g, '/'));
const has = (p) => files.some((f) => f === p || f.startsWith(p));

// 包里必须有的：少一样，装上的人就少一块功能。
const REQUIRED = [
  'LICENSE',
  'README.md',
  'AGENTS.md',
  'CHANGELOG.md',
  'cordis.patch.yml',
  'lib/',
  'media/',
  'scripts/',
  'tools/',
];

// 包里不该有的：测试、仓库文档、维护者自己的东西。
// （docs/ 里是 GitHub 上读的说明，README 用绝对地址链过去，不必进包。）
const FORBIDDEN = ['test/', 'docs/', '.github/', 'SECURITY.md', 'CONTRIBUTING.md', 'RELEASE.md'];

const bad = [];
for (const p of REQUIRED) if (!has(p)) bad.push('缺了 ' + p);
if (!files.some((f) => /^RELEASE-NOTES-[^/]+\.md$/.test(f))) bad.push('缺了 RELEASE-NOTES-*.md');
for (const p of FORBIDDEN) if (has(p)) bad.push('不该有 ' + p);

if (bad.length) {
  console.error('pack 内容不对：\n  - ' + bad.join('\n  - '));
  console.error('\n实际进入包的文件（前 40 个）：\n  ' + files.slice(0, 40).join('\n  '));
  console.error('\n修法：改 package.json 的 files 白名单，别在 CI 里放宽。');
  process.exit(1);
}

console.log(`pack OK：${files.length} 个文件，${(info.size / 1024 / 1024).toFixed(1)} MB（打包前 ${(info.unpackedSize / 1024 / 1024).toFixed(1)} MB）`);
