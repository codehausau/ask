// The JSON Schemas are documentation for editors; the loader is the authority.
// Keep them describing exactly the same settings and limits.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CONFIG_SHAPES, loadSettings, parseJsonc, type Kind, type Shape } from "../src/config.ts";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", import.meta.url.endsWith(".ts") ? "" : "..");
type Schema = Record<string, unknown> & { properties?: Record<string, Schema> };

const EXPECTED: Record<Kind, Record<string, unknown>> = {
  string: { type: ["string", "null"] },
  stringArray: { type: ["array", "null"], items: { type: "string" } },
  boolean: { type: ["boolean", "null"] },
  positiveInteger: { type: ["integer", "null"], minimum: 1 },
  nonNegativeNumber: { type: ["number", "null"], minimum: 0 },
  spinner: { enum: ["auto", "off", "ascii", null] },
  updateView: { enum: ["search-replace", "diff", null] },
  temperature: { type: ["number", "null"], minimum: 0, maximum: 2 },
  timeout: { type: ["number", "null"], exclusiveMinimum: 0, maximum: 2147483.647 },
};

/** Compare a schema object against a loader shape, ignoring descriptions. */
function assertDescribes(schema: Schema, shape: Shape, where: string) {
  assert.equal(schema["additionalProperties"], false, `${where}: unknown keys must be flagged`);
  const properties = { ...schema.properties };
  delete properties["$schema"];
  assert.deepEqual(Object.keys(properties).sort(), Object.keys(shape).sort(), `${where}: keys`);
  for (const [key, kind] of Object.entries(shape)) {
    const property = properties[key]!;
    if (typeof kind === "string") {
      const { description: _description, ...rest } = property;
      assert.deepEqual(rest, EXPECTED[kind], `${where}.${key}`);
    } else {
      assert.deepEqual(property["type"], ["object", "null"], `${where}.${key}`);
      assertDescribes(property, kind, `${where}.${key}`);
    }
  }
}

for (const name of ["ask", "cli", "tui"] as const) {
  test(`schema/${name}.schema.json describes exactly what the loader accepts`, async () => {
    const schema = JSON.parse(await readFile(path.join(PACKAGE, "schema", `${name}.schema.json`), "utf8")) as Schema;
    assert.equal(schema["$schema"], "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema["$id"], `https://raw.githubusercontent.com/codehausau/ask/main/packages/ask/schema/${name}.schema.json`);
    assert.deepEqual(schema.properties?.["$schema"], { type: "string" });
    assertDescribes(schema, CONFIG_SHAPES[name], name);
  });
}

test("the example config points at the schema and loads cleanly", async (t) => {
  const text = await readFile(path.join(PACKAGE, "ask.example.jsonc"), "utf8");
  const example = parseJsonc(text, "ask.example.jsonc") as Record<string, unknown>;
  const schema = JSON.parse(await readFile(path.join(PACKAGE, "schema", "ask.schema.json"), "utf8")) as Schema;
  assert.equal(example["$schema"], schema["$id"]);
  const xdg = await mkdtemp(path.join(tmpdir(), "ask-schema-"));
  t.after(() => rm(xdg, { recursive: true, force: true }));
  await mkdir(path.join(xdg, "ask"));
  await writeFile(path.join(xdg, "ask", "ask.jsonc"), text);
  await chmod(path.join(xdg, "ask", "ask.jsonc"), 0o600);
  const loaded = await loadSettings({ cwd: xdg, env: { XDG_CONFIG_HOME: xdg, ASK_STATE_DIR: path.join(xdg, "state") } });
  assert.deepEqual(loaded.notes, []);
});
