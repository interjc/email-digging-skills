-- 0002_views.sql: query views. Policy: docs/consent-policy.md.

-- Not blocked: still in some source, not suppressed, and no source says denied.
CREATE VIEW v_not_blocked AS
SELECT c.*
FROM contacts c
WHERE c.orphaned_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)
  AND NOT EXISTS (SELECT 1 FROM consents k WHERE k.contact_id = c.id AND k.status = 'denied');

-- Sendable (strict, the export default): not blocked, not a typo suspect, and positive consent:
-- at least one source row says granted, or the contact is in a source that counts as opt-in.
CREATE VIEW v_sendable_strict AS
SELECT nb.*
FROM v_not_blocked nb
WHERE nb.email_status <> 'typo_suspect'
  AND (
    EXISTS (SELECT 1 FROM consents k WHERE k.contact_id = nb.id AND k.status = 'granted')
    OR EXISTS (
      SELECT 1 FROM contact_sources cs JOIN sources s ON s.name = cs.source
      WHERE cs.contact_id = nb.id AND s.counts_as_opt_in = 1
    )
  );

-- Overlap between every pair of sources (a = b gives each source's size).
CREATE VIEW v_source_overlap AS
SELECT a.source AS source_a, b.source AS source_b, COUNT(*) AS contacts
FROM contact_sources a
JOIN contact_sources b ON a.contact_id = b.contact_id
GROUP BY a.source, b.source;
