# final2 fix report

Status: DONE (I1, I2, M1, M2, M3 fixed; M4-M10 skipped as instructed).

- I1: runTick takes an optional `pacing` object ({attempted}); /internal/tick shares one across rounds. Polling mode (no object passed) unchanged. Post-sleep window re-check intact. Tests: tick.test.js (f2) two rounds with injected sleep + polling unchanged; internal.test.js real 2 s gap between rounds with MAX_PER_TICK=1 (verified failing on old code: 1131 ms gap, DB latency only).
- I2: Settings send-window card warning (Notice), README, docs/deploy.md, infra/variables.tf description. Web test added.
- M1/M2: README Replies bullet, Deploy section heading and verified-vs-not wording, Known limits bullet.
- M3: INTERNAL_TICK_DEADLINE_SECONDS default 480 (env.js, README, .env.example, tests).

Verification: backend npm test tests 359, pass 359, fail 0; web vitest 21 files / 130 tests pass; tsc clean; lint clean; npm audit --omit=dev 0 in both.
