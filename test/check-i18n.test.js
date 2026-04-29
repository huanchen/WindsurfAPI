import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());

function makeWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), 'wa-check-i18n-'));

  const srcDir = join(workspace, 'src');
  const dashboardDir = join(srcDir, 'dashboard');
  const i18nDir = join(dashboardDir, 'i18n');

  mkdirSync(srcDir, { recursive: true });
  mkdirSync(dashboardDir, { recursive: true });
  mkdirSync(i18nDir, { recursive: true });
  copyFileSync(join(ROOT, 'package.json'), join(workspace, 'package.json'));
  copyFileSync(join(ROOT, 'src/dashboard/check-i18n.js'), join(dashboardDir, 'check-i18n.js'));
  copyFileSync(join(ROOT, 'src/dashboard/index.html'), join(dashboardDir, 'index.html'));
  copyFileSync(join(ROOT, 'src/dashboard/api.js'), join(dashboardDir, 'api.js'));
  copyFileSync(join(ROOT, 'src/dashboard/i18n/en.json'), join(i18nDir, 'en.json'));
  copyFileSync(join(ROOT, 'src/dashboard/i18n/zh-CN.json'), join(i18nDir, 'zh-CN.json'));

  return workspace;
}

function runCheck(workspace) {
  return spawnSync(process.execPath, ['src/dashboard/check-i18n.js'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 20000,
  });
}

describe('scripts/check-i18n.js', () => {
  it('passes on clean dashboard sources', () => {
    const workspace = makeWorkspace();
    try {
      const result = runCheck(workspace);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /All i18n checks passed/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails with nonzero exit and reports violation when Chinese text is introduced', () => {
    const workspace = makeWorkspace();
    try {
      const indexPath = join(workspace, 'src', 'dashboard', 'index.html');
      const marker = '\n      <!-- i18n test violation -->\n      <div>這是中文硬编码示例</div>\n';
      writeFileSync(indexPath, `${readFileSync(indexPath, 'utf8')}${marker}`, 'utf8');

      const result = runCheck(workspace);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /No hardcoded Chinese found in HTML|hardcoded Chinese/i);
      assert.match(result.stdout, /Found [0-9]+ violation/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
