import fs from 'fs';
import path from 'path';

const parseLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const eqIndex = trimmed.indexOf('=');
  if (eqIndex <= 0) return null;

  const key = trimmed.slice(0, eqIndex).trim();
  let value = trimmed.slice(eqIndex + 1).trim();

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }

  return { key, value };
};

export const loadLocalEnv = (serverRootDir) => {
  const envFilePath = path.resolve(serverRootDir, '.env.local');
  const loaded = {};

  if (!fs.existsSync(envFilePath)) {
    return {
      path: envFilePath,
      values: loaded,
    };
  }

  const raw = fs.readFileSync(envFilePath, 'utf8');
  for (const line of raw.split(/\r?\n/g)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    loaded[parsed.key] = parsed.value;
  }

  return {
    path: envFilePath,
    values: loaded,
  };
};
