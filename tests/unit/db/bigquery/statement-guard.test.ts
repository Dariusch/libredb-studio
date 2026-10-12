import { describe, expect, test } from "bun:test";
import { inspectAgentStatement } from "@/lib/db/operations/statement-guard";
import { resolveSqlGrammar } from "@/lib/sql/grammar";

const grammar = resolveSqlGrammar("bigquery");

describe("the statement guard with the BigQuery grammar", () => {
  test("a # comment is a comment, so it is no longer refused as ambiguous", () => {
    expect(inspectAgentStatement("SELECT 1 # note", { grammar })).toBeNull();
    expect(inspectAgentStatement("SELECT 1 # note", {})).toBe("DIALECT_AMBIGUOUS_TEXT");
  });

  test("a triple-quoted literal holds a semicolon and a write keyword as text", () => {
    expect(inspectAgentStatement("SELECT '''a'b; DROP TABLE x'''", { grammar })).toBeNull();
  });

  test("a write behind a # comment is still the statement doing it", () => {
    expect(inspectAgentStatement("# note\nDROP TABLE `p.d.t`", { grammar })).toBe("NON_READ_STATEMENT");
    expect(inspectAgentStatement("SELECT 1 # note\n; DELETE FROM t WHERE true", { grammar })).toBe(
      "MULTIPLE_STATEMENTS",
    );
  });

  test("a second statement and an unterminated literal are refused", () => {
    expect(inspectAgentStatement("SELECT '''a'''; SELECT 2", { grammar })).toBe("MULTIPLE_STATEMENTS");
    expect(inspectAgentStatement("SELECT '''never closed", { grammar })).toBe("UNDETERMINABLE_TEXT");
  });

  test("a dollar-quoted run stays refused: BigQuery has none, so no reading settles it", () => {
    expect(inspectAgentStatement("SELECT $$a$$", { grammar })).toBe("DIALECT_AMBIGUOUS_TEXT");
  });

  test("ML.*, AI.* and EXTERNAL_QUERY bill or act outside the byte cap and are refused", () => {
    for (const sql of [
      "SELECT * FROM ML.PREDICT(MODEL m.x, (SELECT 1 a))",
      "select * from ml . predict(model m.x, (select 1 a))",
      "SELECT AI.GENERATE('x')",
      "select ai.generate_text('x')",
      "SELECT * FROM EXTERNAL_QUERY('c', 'select 1')",
      "select * from external_query('c', 'select 1')",
    ]) {
      expect(inspectAgentStatement(sql, { grammar })).toBe("SIDE_EFFECT_KEYWORD");
    }
  });

  test("a backticked, commented or widely spaced refused call is still refused (each resolved on BigQuery)", () => {
    for (const sql of [
      "SELECT `ML`.DISTANCE([1.0,2.0],[3.0,4.0])",
      "SELECT `ML.DISTANCE`([1.0,2.0],[3.0,4.0])",
      "SELECT `ml`.x FROM t",
      "SELECT ML /* x */ .DISTANCE([1.0],[2.0])",
      "SELECT ML -- x\n.DISTANCE([1.0],[2.0])",
      "SELECT ML # x\n. /* y */ DISTANCE([1.0],[2.0])",
      `SELECT ML${" ".repeat(100)}.DISTANCE([1.0],[2.0])`,
      "SELECT * FROM `EXTERNAL_QUERY`('conn', 'select 1')",
      "SELECT * FROM `p.d.external_query`('conn', 'select 1')",
      "SELECT `M\\L`.DISTANCE(1)",
    ]) {
      expect(inspectAgentStatement(sql, { grammar })).toBe("SIDE_EFFECT_KEYWORD");
    }
  });

  test("a column named ml or ai, a qualified ml, a string and a comment stay allowed", () => {
    for (const sql of [
      "SELECT ml, ai FROM t",
      "SELECT t.ml, t . ai, `t`.`ml` FROM t",
      "SELECT `ML` FROM t",
      "SELECT t.ml.x FROM t",
      "SELECT ml. 1",
      "SELECT 'ML.PREDICT'",
      'SELECT "ML.PREDICT"',
      "SELECT 1 # ML.PREDICT",
      "SELECT `NOTML`.DISTANCE(1)",
    ]) {
      expect(inspectAgentStatement(sql, { grammar })).toBeNull();
    }
  });

  test("other grammars are unchanged", () => {
    const sql = "SELECT * FROM ML.PREDICT(MODEL m.x, (SELECT 1 a))";
    expect(inspectAgentStatement(sql, {})).toBeNull();
    expect(inspectAgentStatement(sql, { grammar: resolveSqlGrammar("postgres") })).toBeNull();
    expect(
      inspectAgentStatement("SELECT `ML`.x, EXTERNAL_QUERY(1) FROM t", { grammar: resolveSqlGrammar("mysql") }),
    ).toBeNull();
  });
});
