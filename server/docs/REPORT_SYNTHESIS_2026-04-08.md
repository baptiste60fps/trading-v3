# Report Synthesis - 2026-04-08

## Scope

- Runtime daily reports reviewed:
  - `runtime-report-2026-04-02.json`
  - `runtime-report-2026-04-03.json`
  - `runtime-report-2026-04-07.json`
- Daily wake-up reports reviewed:
  - `daily-report-2026-04-02.json`
  - `daily-report-2026-04-03.json`
  - `daily-report-2026-04-07.json`
  - `daily-report-2026-04-08.json`
- Backtest reference reviewed:
  - `batch-1775631560135.json`

## Synthetic Findings

1. `2026-04-02` produced zero trades because the LLM was unavailable, not because the strategy had no ideas.
   - Runtime report shows `skip/noop` throughout the day.
   - Previous blocker: missing local model.

2. `2026-04-03` is not usable as a trading quality day for strategy judgment.
   - It contains historical false openings caused by the pre-fix market calendar path.
   - This is now a corrected architectural issue, not an active strategy signal.

3. `2026-04-07` is the most useful live report for strategy diagnosis.
   - `AAPL`: `2` opening attempts.
   - `TGT`: `8` opening attempts.
   - `CVX`: `9` opening attempts.
   - All were rejected because of the fractional stock order constraint that has since been fixed.

4. The live LLM was directionally active, but too permissive on repeated opening attempts.
   - `CVX` repeatedly proposed long entries even with explicitly overheated reasoning.
   - `TGT` proposed several near-identical mean-reversion entries minute after minute.
   - Without a deterministic post-LLM gate, the live path was looser than the backtested heuristic path.

5. The current heuristic baseline remains acceptable on the classic basket, but uneven.
   - Reference batch `2026-03-07 -> 2026-04-07`, step `30m`:
   - `CVX`: `+32.79`
   - `TGT`: `+28.93`
   - `AAPL`: `-58.86`
   - Aggregate basket: `+2.86`

## Trading Interpretation

- The biggest live weakness is not "no signal".
- It is "LLM opens too easily unless we enforce the profile discipline right before execution".
- `CVX` needs protection against late momentum chasing.
- `AAPL` needs slightly stricter quality confirmation on related context and hot medium RSI.
- Repeated rejected opens should not spam every minute when the broker is already signaling a blocking problem.

## Implemented Upgrade

1. Added a live heuristic entry guard.
   - Every `open_long` proposed by the LLM is now reviewed against the same profile-aware heuristic engine used in backtests.
   - If the heuristic says `skip`, the live decision is downgraded to `skip`.
   - If the heuristic says `open_long`, requested size is clamped to the more conservative size.

2. Added an opening rejection cooldown.
   - After a broker rejection on `open_long`, the strategy now pauses new opening attempts for a short cooldown window.
   - This prevents minute-by-minute repeats on the same blocking condition.

3. Tightened `AAPL` quality rules.
   - Stricter related trend floor.
   - Lower tolerance for hot medium RSI.
   - Slightly tighter chase protection and smaller size cap.

## Intended Effect

- Keep the LLM as a contextual decision layer.
- Re-anchor live execution to the deterministic profile discipline already validated in backtests.
- Reduce overheated entries and repeated retries.
- Improve `AAPL` quality without breaking the overall classic basket behavior.
