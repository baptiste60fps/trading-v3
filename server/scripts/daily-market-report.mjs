import { createRuntime } from '../src/app/createRuntime.mjs';

const parseArgs = (argv) => {
  const args = {
    targetDate: null,
    atMs: null,
    symbols: null,
    writeReport: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    const [flag, inlineValue] = entry.split('=');
    const value = inlineValue ?? argv[index + 1];

    switch (flag) {
      case '--date':
        args.targetDate = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--at':
        args.atMs = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--symbols':
        args.symbols = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--no-write':
        args.writeReport = false;
        break;
      default:
        if (!entry.startsWith('--')) continue;
        throw new Error(`Unsupported flag ${flag}`);
    }
  }

  return args;
};

const normalizeAtMs = (value) => {
  if (!value) return Date.now();
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`Invalid --at value '${value}'`);
};

const parseSymbols = (value) =>
  String(value ?? '')
    .split(',')
    .map((entry) => String(entry).trim().toUpperCase())
    .filter(Boolean);

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const runtime = await createRuntime();
  const report = await runtime.dailyMarketReportService.generate({
    atMs: normalizeAtMs(args.atMs),
    targetSessionDate: args.targetDate,
    symbols: args.symbols ? parseSymbols(args.symbols) : null,
    writeReport: args.writeReport,
  });

  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error('[DAILY REPORT] Failure');
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
