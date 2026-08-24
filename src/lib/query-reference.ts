/**
 * Hand-curated MySQL-flavored reference for the query helpers panel
 * (Phase 9-B). Kept small and static — no IPC, no versioning. Each entry's
 * `signature` renders in the list; the one-line `description` shows as the
 * row tooltip. Clicking a function inserts `NAME(` at the cursor, a keyword
 * inserts the bare word.
 */

export interface ReferenceFunction {
  name: string;
  signature: string;
  description: string;
}

export interface ReferenceGroup {
  label: string;
  functions: ReferenceFunction[];
}

export const REFERENCE_GROUPS: ReferenceGroup[] = [
  {
    label: "String",
    functions: [
      { name: "CONCAT", signature: "CONCAT(str1, str2, …)", description: "Concatenate two or more strings; NULL if any argument is NULL." },
      { name: "CONCAT_WS", signature: "CONCAT_WS(sep, str1, str2, …)", description: "Concatenate with a separator, skipping NULLs." },
      { name: "SUBSTRING", signature: "SUBSTRING(str, pos[, len])", description: "Extract a substring starting at pos (1-based)." },
      { name: "LEFT", signature: "LEFT(str, len)", description: "Leftmost len characters." },
      { name: "RIGHT", signature: "RIGHT(str, len)", description: "Rightmost len characters." },
      { name: "LENGTH", signature: "LENGTH(str)", description: "Byte length of the string (CHAR_LENGTH counts characters)." },
      { name: "UPPER", signature: "UPPER(str)", description: "Uppercase copy of the string." },
      { name: "LOWER", signature: "LOWER(str)", description: "Lowercase copy of the string." },
      { name: "TRIM", signature: "TRIM([remstr FROM] str)", description: "Strip leading/trailing spaces (or remstr)." },
      { name: "REPLACE", signature: "REPLACE(str, from, to)", description: "Replace every occurrence of from with to." },
      { name: "INSTR", signature: "INSTR(str, substr)", description: "Position of the first occurrence of substr (0 if absent)." },
      { name: "FORMAT", signature: "FORMAT(num, decimals)", description: "Number formatted with thousand separators and rounding." },
      { name: "LPAD", signature: "LPAD(str, len, padstr)", description: "Pad on the left up to len characters." },
      { name: "RPAD", signature: "RPAD(str, len, padstr)", description: "Pad on the right up to len characters." },
    ],
  },
  {
    label: "Date & Time",
    functions: [
      { name: "NOW", signature: "NOW()", description: "Current date and time ('YYYY-MM-DD hh:mm:ss')." },
      { name: "CURDATE", signature: "CURDATE()", description: "Current date." },
      { name: "CURTIME", signature: "CURTIME()", description: "Current time." },
      { name: "DATEDIFF", signature: "DATEDIFF(d1, d2)", description: "Days between two dates (d1 − d2)." },
      { name: "DATE_ADD", signature: "DATE_ADD(date, INTERVAL n unit)", description: "Add a time interval to a date/datetime." },
      { name: "DATE_SUB", signature: "DATE_SUB(date, INTERVAL n unit)", description: "Subtract a time interval from a date/datetime." },
      { name: "DATE_FORMAT", signature: "DATE_FORMAT(date, fmt)", description: "Format a date per % placeholders (%Y, %m, %d …)." },
      { name: "STR_TO_DATE", signature: "STR_TO_DATE(str, fmt)", description: "Parse a string into a date using fmt." },
      { name: "UNIX_TIMESTAMP", signature: "UNIX_TIMESTAMP([date])", description: "Seconds since 1970-01-01 UTC." },
      { name: "FROM_UNIXTIME", signature: "FROM_UNIXTIME(unix_ts)", description: "Unix timestamp → datetime string." },
      { name: "EXTRACT", signature: "EXTRACT(unit FROM date)", description: "One field (YEAR, MONTH, HOUR …) of a date." },
      { name: "TIMESTAMPDIFF", signature: "TIMESTAMPDIFF(unit, d1, d2)", description: "Difference in whole units between two datetimes." },
    ],
  },
  {
    label: "Numeric",
    functions: [
      { name: "ROUND", signature: "ROUND(num[, decimals])", description: "Round half away from zero to given decimals." },
      { name: "FLOOR", signature: "FLOOR(num)", description: "Largest integer ≤ num." },
      { name: "CEIL", signature: "CEIL(num)", description: "Smallest integer ≥ num." },
      { name: "ABS", signature: "ABS(num)", description: "Absolute value." },
      { name: "MOD", signature: "MOD(n, m)", description: "Remainder of n divided by m." },
      { name: "TRUNCATE", signature: "TRUNCATE(num, decimals)", description: "Cut off to given decimals without rounding." },
      { name: "RAND", signature: "RAND([seed])", description: "Random float in [0, 1)." },
      { name: "GREATEST", signature: "GREATEST(v1, v2, …)", description: "Largest of the arguments." },
      { name: "LEAST", signature: "LEAST(v1, v2, …)", description: "Smallest of the arguments." },
      { name: "COALESCE", signature: "COALESCE(v1, v2, …)", description: "First non-NULL argument." },
    ],
  },
  {
    label: "Aggregate",
    functions: [
      { name: "COUNT", signature: "COUNT(*) | COUNT(expr)", description: "Row count / count of non-NULL values." },
      { name: "SUM", signature: "SUM(expr)", description: "Total of non-NULL values." },
      { name: "AVG", signature: "AVG(expr)", description: "Mean of non-NULL values." },
      { name: "MIN", signature: "MIN(expr)", description: "Smallest value." },
      { name: "MAX", signature: "MAX(expr)", description: "Largest value." },
      { name: "GROUP_CONCAT", signature: "GROUP_CONCAT(expr [ORDER BY …] [SEPARATOR s])", description: "Concatenate group values into one string." },
      { name: "STDDEV", signature: "STDDEV(expr)", description: "Population standard deviation." },
      { name: "VARIANCE", signature: "VARIANCE(expr)", description: "Population variance." },
    ],
  },
];

/** Uppercase keywords offered in the reference tab. */
export const REFERENCE_KEYWORDS: string[] = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT",
  "OFFSET", "JOIN", "LEFT JOIN", "INNER JOIN", "ON", "AS", "DISTINCT",
  "UNION", "UNION ALL", "INSERT INTO", "VALUES", "UPDATE", "SET",
  "DELETE FROM", "CASE WHEN", "THEN", "ELSE", "END", "AND", "OR",
  "NOT", "NULL", "IS NULL", "IS NOT NULL", "IN", "BETWEEN", "LIKE",
  "REGEXP", "EXISTS", "WITH", "ASC", "DESC",
];
