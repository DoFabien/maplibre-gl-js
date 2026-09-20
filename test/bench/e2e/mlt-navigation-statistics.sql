WITH lagged AS (
    SELECT *, LAG(t) OVER (PARTITION BY network, encoding, run, phase ORDER BY idx) AS previous
    FROM raw_raf
), frame_samples AS (
    SELECT network, encoding, run, phase, t - previous AS value, 'raf' AS metric
    FROM lagged r
    WHERE EXISTS (SELECT 1 FROM motion_windows w
        WHERE w.network = r.network AND w.encoding = r.encoding AND w.run = r.run AND w.phase = r.phase
          AND r.previous >= w.started AND r.t <= w.ended)
), ranked_events AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY network, encoding, run, phase, tile_key, kind ORDER BY idx) AS ordinal
    FROM raw_tile_events
), arrivals AS (
    SELECT s.network, s.encoding, s.run, s.phase, s.t AS started,
        (SELECT MIN(r.t) FROM raw_render r WHERE r.network = s.network AND r.encoding = s.encoding
            AND r.run = s.run AND r.phase = s.phase AND r.t >= d.t) AS submitted
    FROM ranked_events s JOIN ranked_events d
      ON s.network = d.network AND s.encoding = d.encoding AND s.run = d.run AND s.phase = d.phase
     AND s.tile_key = d.tile_key AND s.ordinal = d.ordinal
    WHERE s.kind = 'dataloading' AND d.kind = 'sourcedata'
), samples AS (
    SELECT * FROM frame_samples
    UNION ALL
    SELECT network, encoding, run, phase, submitted - started, 'tileLoad' FROM arrivals WHERE submitted IS NOT NULL
), ranked_samples AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY network, encoding, run, phase, metric ORDER BY value) AS position,
        COUNT(*) OVER (PARTITION BY network, encoding, run, phase, metric) AS n
    FROM samples
), quantiles(label, q) AS (VALUES ('P50Ms', 0.5), ('P95Ms', 0.95), ('P99Ms', 0.99)),
positions AS (
    SELECT *, CAST((n - 1) * q AS INTEGER) AS lower_position, (n - 1) * q - CAST((n - 1) * q AS INTEGER) AS fraction
    FROM ranked_samples CROSS JOIN quantiles
)
SELECT network, encoding, run, phase, metric || label AS metric, n,
    SUM(CASE WHEN position = lower_position + 1 THEN value * (1 - fraction)
             WHEN position = lower_position + 2 THEN value * fraction ELSE 0 END) AS value
FROM positions
GROUP BY network, encoding, run, phase, metric, label
ORDER BY network, encoding, run, phase, metric;
