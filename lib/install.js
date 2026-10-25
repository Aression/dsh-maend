/**
 * Locate the local MaaEnd (MXU) installation without hardcoding a machine path.
 *
 * Resolution order (first hit wins):
 *   1. `MAAEND_HOME` / `MAAEND_INSTALL_DIR` environment variables
 *   2. the plugin config (`apply(ctx, { installDir })`)
 *   3. the directory remembered from a previous successful resolve
 *      (`~/.dsh/maend-install.json`)
 *   4. the basePath MXU reports on `/api/interface` (authoritative while it runs)
 *   5. the image path of a running `MaaEnd.exe`
 *   6. a shallow scan of the usual Windows download locations
 *
 * A candidate is only accepted when it actually contains `MaaEnd.exe`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE_NAME = 'MaaEnd.exe';
const STATE_FILE = path.join(os.homedir(), '.dsh', 'maend-install.json');

function isDirLike(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasExe(dir) {
  if (!isDirLike(dir)) return false;
  try {
    return fs.statSync(path.join(dir, EXE_NAME)).isFile();
  } catch {
    return false;
  }
}

export function readRemembered() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return isDirLike(parsed?.dir) ? path.resolve(parsed.dir) : null;
  } catch {
    return null;
  }
}

export function remember(dir) {
  if (!hasExe(dir)) return false;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ dir: path.resolve(dir), savedAt: new Date().toISOString() }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function runningProcessDir() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', '(Get-Process MaaEnd -ErrorAction SilentlyContinue | Select-Object -First 1).Path'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    ).trim();
    return out ? path.dirname(out) : null;
  } catch {
    return null;
  }
}

function scanCommonRoots() {
  const roots = [];
  const home = os.homedir();
  const push = (dir) => {
    if (!isDirLike(dir)) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && /maae?nd/i.test(entry.name)) roots.push(path.join(dir, entry.name));
      }
    } catch {
      /* ignore unreadable roots */
    }
  };
  if (process.platform !== 'win32') return roots;
  push(path.join(home, 'Downloads'));
  push(path.join(home, 'Desktop'));
  push(path.join(home, 'Documents'));
  push('C:\\Games');
  push('D:\\Games');
  push(path.join(process.env.LOCALAPPDATA ?? '', 'Programs'));
  return roots;
}

/**
 * @param {{ configDir?: string, mxuBasePath?: string }} hints
 * @returns {{ dir: string, exe: string, source: string } | null}
 */
export function resolveInstall({ configDir, mxuBasePath } = {}) {
  const candidates = [
    ['env:MAAEND_HOME', process.env.MAAEND_HOME],
    ['env:MAAEND_INSTALL_DIR', process.env.MAAEND_INSTALL_DIR],
    ['config:installDir', configDir],
    ['remembered', readRemembered()],
    ['mxu:basePath', mxuBasePath],
    ['process', runningProcessDir()],
    ...scanCommonRoots().map((dir) => ['scan', dir]),
  ];
  for (const [source, dir] of candidates) {
    if (!isDirLike(dir)) continue;
    const resolved = path.resolve(dir.trim());
    if (!hasExe(resolved)) continue;
    if (source !== 'remembered') remember(resolved);
    return { dir: resolved, exe: path.join(resolved, EXE_NAME), source };
  }
  return null;
}

export { EXE_NAME, hasExe };
