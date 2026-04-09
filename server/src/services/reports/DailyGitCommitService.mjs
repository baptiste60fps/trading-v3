import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const safeString = (value, fallback = null) => {
  const text = String(value ?? '').trim();
  return text ? text : fallback;
};

const unique = (values) => Array.from(new Set(values));

export class DailyGitCommitService {
  constructor({
    repoRootDir,
    configStore,
    logger = console,
    execFileSyncImpl = execFileSync,
  } = {}) {
    this.repoRootDir = path.resolve(repoRootDir ?? process.cwd());
    this.configStore = configStore;
    this.logger = logger ?? console;
    this.execFileSyncImpl = typeof execFileSyncImpl === 'function' ? execFileSyncImpl : execFileSync;
  }

  async commitArtifacts({
    sessionDate = null,
    runtimeMode = null,
    symbols = [],
    paths = [],
  } = {}) {
    const gitConfig = this.configStore?.getGitConfig?.() ?? {};
    if (gitConfig?.dailyAutoCommitEnabled !== true) {
      return { committed: false, skipped: true, reason: 'disabled' };
    }

    const repoPaths = this.#normalizePaths(paths);
    if (!repoPaths.length) {
      return { committed: false, skipped: true, reason: 'no_paths' };
    }

    if (!this.#isGitRepository()) {
      return { committed: false, skipped: true, reason: 'not_git_repo' };
    }

    const relativePaths = repoPaths.map((entry) => path.relative(this.repoRootDir, entry));
    const statusOutput = this.#runGit(['status', '--porcelain', '--', ...relativePaths], { allowFailure: false });
    if (!String(statusOutput ?? '').trim()) {
      return { committed: false, skipped: true, reason: 'no_changes', paths: relativePaths };
    }

    this.#runGit(['add', '--', ...relativePaths], { allowFailure: false });
    const stagedOutput = this.#runGit(['diff', '--cached', '--name-only', '--', ...relativePaths], { allowFailure: false });
    if (!String(stagedOutput ?? '').trim()) {
      return { committed: false, skipped: true, reason: 'no_staged_changes', paths: relativePaths };
    }

    const message = this.#buildCommitMessage({
      sessionDate,
      runtimeMode,
      symbols,
      prefix: gitConfig?.commitMessagePrefix,
    });

    const commitResult = this.#runGit(['commit', '--only', '-m', message, '--', ...relativePaths], {
      allowFailure: true,
    });
    if (commitResult.ok === false) {
      const output = `${commitResult.stdout ?? ''}\n${commitResult.stderr ?? ''}`.trim();
      if (output.includes('nothing to commit')) {
        return { committed: false, skipped: true, reason: 'nothing_to_commit', paths: relativePaths };
      }
      throw new Error(output || 'git commit failed');
    }

    this.logger?.log?.(`[GIT] Daily artifacts committed for ${sessionDate ?? 'unknown_session'} (${relativePaths.join(', ')})`);
    return {
      committed: true,
      skipped: false,
      message,
      paths: relativePaths,
    };
  }

  #normalizePaths(paths) {
    return unique((Array.isArray(paths) ? paths : [])
      .map((entry) => safeString(entry))
      .filter(Boolean)
      .map((entry) => path.resolve(entry))
      .filter((entry) => fs.existsSync(entry))
      .filter((entry) => entry === this.repoRootDir || entry.startsWith(`${this.repoRootDir}${path.sep}`)));
  }

  #buildCommitMessage({ sessionDate, runtimeMode, symbols, prefix }) {
    const safePrefix = safeString(prefix, 'chore(runtime)');
    const parts = [
      safePrefix,
      safeString(sessionDate, 'unknown-session'),
    ];

    const safeMode = safeString(runtimeMode);
    if (safeMode) parts.push(safeMode);

    const safeSymbols = unique((Array.isArray(symbols) ? symbols : [])
      .map((entry) => safeString(entry))
      .filter(Boolean));
    if (safeSymbols.length) {
      parts.push(safeSymbols.join(','));
    }

    return parts.join(' | ');
  }

  #isGitRepository() {
    const result = this.#runGit(['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
    return result.ok !== false && String(result.stdout ?? '').trim() === 'true';
  }

  #runGit(args, { allowFailure = false } = {}) {
    try {
      const stdout = this.execFileSyncImpl('git', args, {
        cwd: this.repoRootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return allowFailure ? { ok: true, stdout, stderr: '' } : stdout;
    } catch (error) {
      if (!allowFailure) {
        const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.trim();
        throw new Error(output || error?.message || 'git command failed');
      }
      return {
        ok: false,
        stdout: String(error?.stdout ?? ''),
        stderr: String(error?.stderr ?? ''),
      };
    }
  }
}
