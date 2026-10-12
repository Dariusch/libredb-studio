import { describe, expect, test } from "bun:test";
import { statementScope, type ScopeSource } from "@/lib/editor/sql-scope";

/** The scope at the `|` in `sql`, which is removed first. */
function scopeAt(sql: string) {
  const cursor = sql.indexOf("|");
  return statementScope(sql.slice(0, cursor) + sql.slice(cursor + 1), cursor);
}
const names = (sources: readonly ScopeSource[]) => sources.map((s) => s.name?.join(".") ?? (s.opaque ? "?" : "()"));

describe("statementScope", () => {
  test("reads backticked, dotted, double-quoted, bracketed and joined references with their aliases", () => {
    const { sources } = scopeAt(
      'SELECT | FROM `my_project.sales_2026_01_01.events` e JOIN ds.other AS o ON 1=1 JOIN "s"."t" LEFT JOIN [dbo].[x] JOIN plain',
    );
    expect(sources.map((s) => s.name)).toEqual([
      ["my_project", "sales_2026_01_01", "events"],
      ["ds", "other"],
      ["s", "t"],
      ["dbo", "x"],
      ["plain"],
    ]);
    expect(sources.map((s) => s.alias)).toEqual(["e", "o", undefined, undefined, undefined]);
  });

  test("a hyphenated project id is part of the name", () => {
    expect(names(scopeAt("SELECT | FROM t \nJOIN my-proj.ds.events e").sources)).toEqual(["t", "my-proj.ds.events"]);
  });

  test("reads every item of a comma-separated FROM list", () => {
    const { sources } = scopeAt("SELECT | FROM users u, orders AS o, products WHERE 1=1");
    expect(names(sources)).toEqual(["users", "orders", "products"]);
    expect(sources.map((s) => s.alias)).toEqual(["u", "o", undefined]);
  });

  test("INTO and UPDATE name their target", () => {
    expect(names(scopeAt("INSERT INTO users (id, |").sources)).toEqual(["users"]);
    const update = scopeAt("UPDATE users u SET |").sources;
    expect(names(update)).toEqual(["users"]);
    expect(update[0].alias).toBe("u");
    expect(names(scopeAt("DELETE FROM orders WHERE |").sources)).toEqual(["orders"]);
  });

  test("a dialect's table modifier is no alias", () => {
    for (const sql of [
      "SELECT | FROM events FINAL WHERE 1=1",
      "SELECT | FROM events FORCE INDEX (ix) WHERE 1=1",
      "SELECT | FROM events CROSS APPLY fn(x)",
    ]) {
      expect(scopeAt(sql).sources[0].alias).toBeUndefined();
    }
  });

  test("a table function is opaque, and keeps its alias", () => {
    const { sources } = scopeAt("SELECT | FROM generate_series(1, 3) g JOIN UNNEST(arr) AS x ON true");
    expect(names(sources)).toEqual(["?", "?"]);
    expect(sources.map((s) => s.alias)).toEqual(["g", "x"]);
  });

  test("a JOIN ... USING column list names no source", () => {
    expect(names(scopeAt("SELECT * FROM a JOIN b USING (|").sources)).toEqual(["a", "b"]);
  });

  test("inside a subquery its own tables come first, then the enclosing query's", () => {
    const { sources } = scopeAt("SELECT * FROM users WHERE id IN (SELECT user_id FROM orders WHERE |)");
    expect(names(sources)).toEqual(["orders", "users"]);
    expect(sources.map((s) => s.depth)).toEqual([1, 0]);
  });

  test("outside a subquery its tables are not in scope", () => {
    expect(names(scopeAt("SELECT | FROM users WHERE id IN (SELECT user_id FROM orders)").sources)).toEqual(["users"]);
  });

  test("a derived table yields its select list's names", () => {
    const [derived] = scopeAt(
      "SELECT | FROM (SELECT id, name AS n, count(*) total, a + b, u.* FROM users u) s",
    ).sources;
    expect(derived.alias).toBe("s");
    expect(derived.derived!.columns).toEqual(["id", "n", "total"]);
    expect(derived.derived!.star).toBe(true);
    expect(names(derived.derived!.sources)).toEqual(["users"]);
  });

  test("a CTE yields its select list, or its declared columns, and is named in the scope", () => {
    const scope = scopeAt(
      "WITH c AS (SELECT id, email FROM users), d (x, y) AS MATERIALIZED (SELECT 1, 2) SELECT | FROM c JOIN d",
    );
    expect(scope.ctes).toEqual(["c", "d"]);
    expect(scope.sources.map((s) => s.name)).toEqual([["c"], ["d"]]);
    expect(scope.sources.map((s) => s.derived?.columns)).toEqual([
      ["id", "email"],
      ["x", "y"],
    ]);
  });

  test("inside a CTE body only the body's tables are in scope", () => {
    expect(names(scopeAt("WITH c AS (SELECT | FROM users) SELECT * FROM c JOIN orders").sources)).toEqual(["users"]);
  });

  test("a recursive CTE reads its first branch and does not loop", () => {
    const [r] = scopeAt("WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r) SELECT | FROM r").sources;
    expect(r.derived!.columns).toEqual(["n"]);
    expect(r.derived!.sources).toEqual([]);
  });

  test("names nothing without FROM", () => {
    expect(scopeAt("SELECT 1|").sources).toEqual([]);
  });

  test("an alias's column list renames a derived source, and shapes a table function", () => {
    const [sub] = scopeAt("SELECT | FROM (SELECT x AS y, z FROM t) AS s(a, b)").sources;
    expect(sub.derived!.columns).toEqual(["a", "b"]);
    expect(sub.derived!.star).toBe(false);
    const [fn] = scopeAt("SELECT | FROM generate_series(1, 3) AS g(n)").sources;
    expect(fn.opaque).toBeUndefined();
    expect(fn.derived!.columns).toEqual(["n"]);
  });

  test("an expression ending in a keyword or after an operator word yields no name", () => {
    const [s] = scopeAt("SELECT | FROM (SELECT id IS NULL, a AND b, flag IS NOT TRUE, c FROM t) s").sources;
    expect(s.derived!.columns).toEqual(["c"]);
  });

  test("UPDATE after ON, FOR or KEY names no source", () => {
    expect(names(scopeAt("INSERT INTO orders (id) VALUES (1) ON DUPLICATE KEY UPDATE amount = |").sources)).toEqual([
      "orders",
    ]);
    expect(names(scopeAt("SELECT * FROM orders FOR UPDATE |").sources)).toEqual(["orders"]);
  });

  test("a WITH after CREATE ... AS or INSERT INTO is read like a leading one", () => {
    for (const sql of [
      "CREATE VIEW v AS WITH c AS (SELECT id FROM users) SELECT | FROM c",
      "CREATE TABLE t AS WITH c AS (SELECT id FROM users) SELECT | FROM c",
      "INSERT INTO t WITH c AS (SELECT id FROM users) SELECT | FROM c",
    ]) {
      const scope = scopeAt(sql);
      expect(scope.ctes).toEqual(["c"]);
      expect(scope.sources.find((s) => s.name?.[0] === "c")?.derived?.columns).toEqual(["id"]);
    }
  });

  test("a WITH inside a subquery is read for that subquery and those it encloses", () => {
    const inside = scopeAt("SELECT * FROM (WITH c AS (SELECT id FROM users) SELECT | FROM c) s");
    expect(inside.ctes).toEqual(["c"]);
    expect(inside.sources[0].derived?.columns).toEqual(["id"]);
    const outside = scopeAt("SELECT | FROM (WITH c AS (SELECT id FROM users) SELECT id FROM c) s");
    expect(outside.ctes).toEqual([]);
    expect(outside.sources[0].derived?.columns).toEqual(["id"]);
    expect(names(outside.sources[0].derived!.sources)).toEqual(["c"]);
    expect(outside.sources[0].derived!.sources[0].derived?.columns).toEqual(["id"]);
  });

  test("a WITH keyword that defines nothing is no CTE list", () => {
    expect(scopeAt("SELECT | FROM t WITH (NOLOCK)").ctes).toEqual([]);
    expect(scopeAt("SELECT | FROM t GROUP BY a WITH ROLLUP").ctes).toEqual([]);
  });

  test("inside a nested CTE body only that body's sources are in scope", () => {
    expect(names(scopeAt("SELECT * FROM (WITH c AS (SELECT | FROM users) SELECT id FROM c) s").sources)).toEqual([
      "users",
    ]);
  });
});
