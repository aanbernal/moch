import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, PIPELINE_VERSION } from "../lib/paths.mjs";
import { STAGES } from "../scripts/build.mjs";

const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "deploy.yml"), "utf8");

test("PIPELINE_VERSION in deploy.yml equals lib/paths.mjs", () => {
  const m = workflow.match(/^\s*PIPELINE_VERSION:\s*"?([^"\s#]+)"?/m);
  assert.ok(m, "PIPELINE_VERSION not found in deploy.yml");
  assert.equal(m[1], PIPELINE_VERSION);
});

test("deploy.yml has the required structure", () => {
  assert.match(workflow, /group:\s*deploy/);
  assert.match(workflow, /cancel-in-progress:\s*true/);
  assert.match(workflow, /name:\s*OPEN_ITEMS/);
  assert.match(workflow, /retention-days:\s*30/);
  assert.match(workflow, /pages deploy dist --project-name=\$\{\{ vars\.CF_PROJECT \}\} --branch=main/);
  assert.match(workflow, /ffmpeg poppler-utils/);
});

test("build chain runs the stages in order, with open-items between media and eleventy", () => {
  assert.deepEqual(
    STAGES.map((s) => s.name),
    ["guard pre", "media", "open-items", "eleventy", "guard post", "verify-dist"],
  );
});
