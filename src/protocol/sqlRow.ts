// TimeZero sends table rows as a comma-separated list of SQLite literals:
// NULL, numbers, 'text' (a quote inside text is doubled) and X'hex' blobs.
// Text may contain commas and newlines, so the row has to be tokenised.

export type SqlValue = null | number | string | Buffer;

export function parseRow(row: string): SqlValue[] {
  const values: SqlValue[] = [];
  let i = 0;
  const n = row.length;
  for (;;) {
    if (row[i] === "'") {
      let text = "";
      i++;
      for (;;) {
        if (i >= n) throw new Error("unterminated text literal");
        if (row[i] === "'") {
          if (row[i + 1] === "'") {
            text += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        text += row[i++];
      }
      values.push(text);
    } else if ((row[i] === "X" || row[i] === "x") && row[i + 1] === "'") {
      const end = row.indexOf("'", i + 2);
      if (end < 0) throw new Error("unterminated blob literal");
      const hex = row.slice(i + 2, end);
      if (!/^(?:[0-9A-Fa-f]{2})*$/.test(hex))
        throw new Error("bad blob literal");
      values.push(Buffer.from(hex, "hex"));
      i = end + 1;
    } else {
      let end = row.indexOf(",", i);
      if (end < 0) end = n;
      const token = row.slice(i, end).trim();
      if (token === "NULL") values.push(null);
      else if (token !== "" && Number.isFinite(Number(token)))
        values.push(Number(token));
      else throw new Error(`bad literal: ${token}`);
      i = end;
    }
    if (i >= n) return values;
    if (row[i] !== ",") throw new Error(`expected ',' at ${i}`);
    i++;
  }
}

export function formatValue(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (Buffer.isBuffer(value))
    return `X'${value.toString("hex").toUpperCase()}'`;
  return `'${value.replace(/'/g, "''")}'`;
}

export function formatRow(values: SqlValue[]): string {
  return values.map(formatValue).join(",");
}
