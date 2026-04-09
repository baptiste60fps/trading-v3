import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { DailyGitCommitService } from '../../src/services/reports/DailyGitCommitService.mjs';
import { makeTempDir } from '../helpers/fixtures.mjs';

const makeConfigStore = (gitConfig = {}) => ({
  getGitConfig() {
    return {
      dailyAutoCommitEnabled: true,
      includeRuntimeSessionState: true,
      commitMessagePrefix: 'chore(runtime)',
      ...gitConfig,
    };
  },
});

export const register = async ({ test }) => {
  test('DailyGitCommitService stages and commits only generated artifact paths', async () => {
    const repoRootDir = makeTempDir();
    const reportsDir = path.resolve(repoRootDir, 'server/storage/reports/runtime-daily');
    const runsDir = path.resolve(repoRootDir, 'server/storage/runs');
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.mkdirSync(runsDir, { recursive: true });

    const reportPath = path.resolve(reportsDir, 'runtime-report-2026-04-09.json');
    const sessionStatePath = path.resolve(runsDir, 'runtime-session-2026-04-09.json');
    fs.writeFileSync(reportPath, '{}\n', 'utf8');
    fs.writeFileSync(sessionStatePath, '{}\n', 'utf8');

    const commands = [];
    const service = new DailyGitCommitService({
      repoRootDir,
      configStore: makeConfigStore(),
      logger: { log() {} },
      execFileSyncImpl(command, args) {
        commands.push([command, ...args]);
        const joined = args.join(' ');
        if (joined.startsWith('rev-parse')) return 'true\n';
        if (joined.startsWith('status --porcelain')) return ' M server/storage/reports/runtime-daily/runtime-report-2026-04-09.json\n';
        if (joined.startsWith('diff --cached --name-only')) return 'server/storage/reports/runtime-daily/runtime-report-2026-04-09.json\n';
        if (joined.startsWith('add --')) return '';
        if (joined.startsWith('commit --only')) return '[main abc123] chore(runtime)\n';
        throw new Error(`Unexpected git command: ${joined}`);
      },
    });

    const result = await service.commitArtifacts({
      sessionDate: '2026-04-09',
      runtimeMode: 'paper',
      symbols: ['BTC/USD', 'ETH/USD'],
      paths: [reportPath, sessionStatePath],
    });

    assert.equal(result.committed, true);
    assert.ok(commands.some((entry) => entry.includes('status')));
    assert.ok(commands.some((entry) => entry.includes('add')));
    assert.ok(commands.some((entry) => entry.includes('commit')));
    const commitCommand = commands.find((entry) => entry.includes('commit'));
    assert.ok(commitCommand.includes('server/storage/reports/runtime-daily/runtime-report-2026-04-09.json'));
    assert.ok(commitCommand.includes('server/storage/runs/runtime-session-2026-04-09.json'));
  });

  test('DailyGitCommitService skips clean sessions cleanly', async () => {
    const repoRootDir = makeTempDir();
    const reportsDir = path.resolve(repoRootDir, 'server/storage/reports/runtime-daily');
    fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.resolve(reportsDir, 'runtime-report-2026-04-09.json');
    fs.writeFileSync(reportPath, '{}\n', 'utf8');

    const service = new DailyGitCommitService({
      repoRootDir,
      configStore: makeConfigStore(),
      logger: { log() {} },
      execFileSyncImpl(command, args) {
        const joined = args.join(' ');
        if (joined.startsWith('rev-parse')) return 'true\n';
        if (joined.startsWith('status --porcelain')) return '';
        throw new Error(`Unexpected git command: ${joined}`);
      },
    });

    const result = await service.commitArtifacts({
      sessionDate: '2026-04-09',
      runtimeMode: 'paper',
      symbols: ['BTC/USD'],
      paths: [reportPath],
    });

    assert.equal(result.committed, false);
    assert.equal(result.reason, 'no_changes');
  });
};
