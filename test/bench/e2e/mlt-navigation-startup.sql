WITH ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY network, encoding ORDER BY initial_ms) AS position,
        COUNT(*) OVER (PARTITION BY network, encoding) AS n
    FROM initial_sessions
)
SELECT network, encoding, COUNT(*) AS sessions,
    AVG(CASE WHEN position IN ((n + 1) / 2, (n + 2) / 2) THEN initial_ms END) AS initialMs,
    MIN(payload_bytes) AS minPayloadBytes, MAX(payload_bytes) AS maxPayloadBytes
FROM ranked
GROUP BY network, encoding
ORDER BY network, encoding;
