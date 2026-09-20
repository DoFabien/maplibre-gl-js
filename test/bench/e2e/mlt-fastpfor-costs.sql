WITH session_allocations AS (
    SELECT variant, run, context, SUM(self_bytes) AS bytes
    FROM raw_profile_frames
    GROUP BY variant, run, context
), ranked_sessions AS (
    SELECT *,
        ROW_NUMBER() OVER (PARTITION BY variant, context ORDER BY bytes) AS position,
        COUNT(*) OVER (PARTITION BY variant, context) AS n
    FROM session_allocations
), allocation_medians AS (
    SELECT variant, context, AVG(bytes) / 1048576.0 AS mio
    FROM ranked_sessions
    WHERE position IN ((n + 1) / 2, (n + 2) / 2)
    GROUP BY variant, context
), tile_totals AS (
    SELECT variant, SUM(bytes) / 1000.0 AS brut_ko, SUM(gzip) / 1000.0 AS gzip_ko
    FROM raw_tile_sizes
    GROUP BY variant
)
SELECT a.variant,
    MAX(CASE WHEN a.context = 'worker' THEN a.mio END) AS allocations_worker_mio,
    MAX(CASE WHEN a.context = 'main' THEN a.mio END) AS allocations_main_mio,
    t.brut_ko, t.gzip_ko
FROM allocation_medians a
JOIN tile_totals t ON t.variant = a.variant
GROUP BY a.variant
ORDER BY a.variant;
