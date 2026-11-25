import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { THEME_ROLES } from "../src/custom-themes.ts";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", import.meta.url.endsWith(".ts") ? "" : "..");

test("schema/theme.schema.json lists exactly the theme keys, with the loader's colour rule", async () => {
  const schema = JSON.parse(await readFile(path.join(PACKAGE, "schema", "theme.schema.json"), "utf8"));
  assert.equal(schema.$id, "https://raw.githubusercontent.com/codehausau/ask/main/packages/ask-tui/schema/theme.schema.json");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["$schema", "extends", "mode", ...THEME_ROLES].sort());
  assert.deepEqual(schema.properties.mode.enum, ["dark", "light"]);
  for (const role of THEME_ROLES) {
    const pattern = new RegExp(schema.properties[role].pattern);
    for (const ok of ["#88c0d0", "#88C0D0", "#88c0d0ff"]) assert.match(ok, pattern, `${role} accepts ${ok}`);
    for (const bad of ["red", "#88c0d", "#88c0d0f", "\u001b]0;x\u0007", "#88c0d0\n"]) assert.doesNotMatch(bad, pattern, `${role} rejects ${JSON.stringify(bad)}`);
  }
});
