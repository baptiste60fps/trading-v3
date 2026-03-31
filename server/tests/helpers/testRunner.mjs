import path from 'path';
import { pathToFileURL } from 'url';

const color = {
  green: (value) => `\x1b[32m${value}\x1b[0m`,
  red: (value) => `\x1b[31m${value}\x1b[0m`,
  yellow: (value) => `\x1b[33m${value}\x1b[0m`,
  cyan: (value) => `\x1b[36m${value}\x1b[0m`,
};

export const createRunner = ({ title = 'tests' } = {}) => {
  const tests = [];

  const test = (name, fn) => {
    tests.push({ name, fn });
  };

  const loadFile = async (filePath) => {
    const moduleUrl = pathToFileURL(path.resolve(filePath)).href;
    const mod = await import(moduleUrl);
    const register = mod.register ?? mod.default;
    if (typeof register !== 'function') {
      throw new Error(`Test file ${filePath} must export a register() function`);
    }
    await register({ test });
  };

  const run = async () => {
    console.log(color.cyan(`[TEST] ${title}`));
    let passed = 0;
    let failed = 0;

    for (const entry of tests) {
      try {
        await entry.fn();
        passed += 1;
        console.log(color.green(`  PASS ${entry.name}`));
      } catch (error) {
        failed += 1;
        console.log(color.red(`  FAIL ${entry.name}`));
        console.error(error?.stack ?? error);
      }
    }

    const summary = {
      title,
      total: tests.length,
      passed,
      failed,
    };

    if (failed > 0) {
      console.log(color.red(`[TEST] ${title}: ${passed}/${tests.length} passed, ${failed} failed`));
      const error = new Error(`Test suite failed: ${title}`);
      error.summary = summary;
      throw error;
    }

    console.log(color.green(`[TEST] ${title}: ${passed}/${tests.length} passed`));
    return summary;
  };

  return {
    test,
    loadFile,
    run,
  };
};
