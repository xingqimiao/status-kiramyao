-- 0003_rewrite_fetch_failed_errors.sql — the other unreadable error string.
--
-- Same bug as 0002, different spelling. `fetch` rejects with `TypeError: fetch failed`
-- and hides the reason on `.cause`; the old catch reported `caught.message`, so the page
-- carried the literal text "fetch failed" — true of every failed fetch and therefore
-- informative about none of them. `worker/src/probe.mjs` now walks the cause chain
-- (`describeFetchFailure`) and a test in `worker/test/probe.test.mjs` holds it.
--
-- These rows cannot be improved the way 0002's could: the cause was never recorded, so
-- there is no underlying reason left to recover. The replacement says the one thing that
-- is still true — the request failed before a response existed — and names the layer that
-- failed, which is more than the old string did.
--
-- Rewritten, not deleted, on the same reasoning as 0002: the failures were real, and the
-- uptime history is the record worth keeping.
--
-- Matched on the exact old string, so this is idempotent.

UPDATE probes
SET error = 'the request failed before any response arrived (network or TLS error)'
WHERE error = 'fetch failed';
