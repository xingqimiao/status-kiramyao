-- 0002_rewrite_http_zero_errors.sql — rename the errors nobody could read.
--
-- `worker/src/probe.mjs` reported a request that never reached an origin as
-- `HTTP ${res.status}`, and Cloudflare gives such a request a Response with `status: 0`
-- rather than throwing. So the check produced the literal text `HTTP 000`: not an HTTP
-- status code, nothing a reader can look up, and the same string whether the cause was a
-- refused connection, a DNS failure or a handshake that did not finish. The code is fixed
-- (status 0 is now named for what it is, with a test in `worker/test/probe.test.mjs`), and
-- this rewrites the rows that were already written under the old wording.
--
-- Rewritten rather than deleted, on purpose. The probes are real: the services genuinely
-- did not answer at those times, and `status_code IS NULL` on all 24 rows is the proof
-- that no response arrived. The record of *when* a thing was unreachable is the whole
-- point of this table; only the sentence attached to it was wrong. Deleting them would
-- erase real downtime from the uptime history to fix a wording bug.
--
-- Matched on the exact old string, so a row that already carries the new wording (or any
-- other) is left alone; this migration is idempotent.

UPDATE probes
SET error = 'no answer from the origin — it refused the connection or could not be reached'
WHERE error = 'HTTP 000';
