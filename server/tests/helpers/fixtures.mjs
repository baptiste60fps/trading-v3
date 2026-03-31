import fs from 'fs';
import os from 'os';
import path from 'path';

export const makeTempDir = (prefix = 'baptisto-v3-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export const makeServerRootFixture = ({ runtimeConfig = {}, envLocal = null } = {}) => {
  const rootDir = makeTempDir();
  fs.mkdirSync(path.join(rootDir, 'storage/configs'), { recursive: true });

  fs.writeFileSync(
    path.join(rootDir, 'storage/configs/runtime.json'),
    JSON.stringify(runtimeConfig, null, 2),
    'utf8',
  );

  if (typeof envLocal === 'string') {
    fs.writeFileSync(path.join(rootDir, '.env.local'), envLocal, 'utf8');
  }

  return rootDir;
};
