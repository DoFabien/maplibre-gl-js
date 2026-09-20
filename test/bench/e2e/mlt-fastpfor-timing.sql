WITH ranked_samples AS (
    SELECT *,
        ROW_NUMBER() OVER (PARTITION BY variant, phase, run, metric ORDER BY value) AS position,
        COUNT(*) OVER (PARTITION BY variant, phase, run, metric) AS n
    FROM raw_timing_samples
), session_medians AS (
    SELECT variant, phase, run, metric, AVG(value) AS value
    FROM ranked_samples
    WHERE position IN ((n + 1) / 2, (n + 2) / 2)
    GROUP BY variant, phase, run, metric
), ranked_sessions AS (
    SELECT *,
        ROW_NUMBER() OVER (PARTITION BY variant, phase, metric ORDER BY value) AS position,
        COUNT(*) OVER (PARTITION BY variant, phase, metric) AS n
    FROM session_medians
), aggregates AS (
    SELECT variant, phase, metric, AVG(value) AS value
    FROM ranked_sessions
    WHERE position IN ((n + 1) / 2, (n + 2) / 2)
    GROUP BY variant, phase, metric
)
SELECT variant, phase,
    MAX(CASE WHEN metric = 'firstRenderMs' THEN value END) AS dessin_ms,
    MAX(CASE WHEN metric = 'queryMs' THEN value END) AS requetes_ms,
    (SELECT MIN(s.value) FROM session_medians s WHERE s.variant = a.variant AND s.phase = a.phase AND s.metric = 'firstRenderMs') AS min_mediane_ms,
    (SELECT MAX(s.value) FROM session_medians s WHERE s.variant = a.variant AND s.phase = a.phase AND s.metric = 'firstRenderMs') AS max_mediane_ms
FROM aggregates a
GROUP BY variant, phase
ORDER BY variant, phase;
