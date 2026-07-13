-- Run in a generated benchmark database after fixture creation.
-- This script is diagnostic only; the harness emits the same core data as JSON.

SELECT
  c.relname AS table_name,
  c.reltoastrelid::regclass::text AS toast_relation,
  pg_relation_size(c.oid) AS main_bytes,
  pg_indexes_size(c.oid) AS index_bytes,
  CASE
    WHEN c.reltoastrelid = 0 THEN 0
    ELSE pg_total_relation_size(c.reltoastrelid)
  END AS toast_bytes,
  pg_total_relation_size(c.oid) AS total_bytes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'tenants', 'accounts', 'tags', 'documents', 'comments',
    'attachments', 'document_tags', 'events'
  )
ORDER BY c.relname;

SELECT
  count(*) AS document_rows,
  count(*) FILTER (WHERE body IS NULL) AS null_bodies,
  count(*) FILTER (WHERE body IS NOT NULL AND pg_column_size(body) < 2000) AS inline_bodies,
  count(*) FILTER (WHERE body IS NOT NULL AND octet_length(body) >= 8192) AS wide_bodies,
  sum(octet_length(body)) AS logical_body_bytes,
  sum(pg_column_size(body)) AS stored_body_datum_bytes
FROM documents;

SELECT
  pg_column_compression(body) AS compression,
  count(*) AS rows,
  sum(octet_length(body)) AS logical_bytes,
  sum(pg_column_size(body)) AS stored_datum_bytes
FROM documents
WHERE body IS NOT NULL
GROUP BY pg_column_compression(body)
ORDER BY compression;

SELECT
  count(*) AS attachment_rows,
  sum(octet_length(data)) AS logical_bytes,
  sum(pg_column_size(data)) AS stored_datum_bytes
FROM attachments;
