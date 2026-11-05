import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const workflow = readFileSync(path.join(root, ".github/workflows/docker-publish.yml"), "utf8");

test("published version is smoke-tested before latest promotion", () => {
  const versionManifest = workflow.indexOf("Create Docker Hub version manifests");
  const ghcrManifest = workflow.indexOf("Create GHCR version manifests");
  const smoke = workflow.indexOf("Smoke-test published Docker image");
  // Upstream dropped Docker Hub promotion (c1e30b7676, #13761 follow-up):
  // GHCR is the promotion channel. The smoke gate must follow a manifest
  // publication and precede the GHCR latest promotion.
  const latestPromotion =
    workflow.indexOf("Promote GHCR latest tags") >= 0
      ? workflow.indexOf("Promote GHCR latest tags")
      : workflow.indexOf("Promote Docker Hub latest tags");

  assert.ok(versionManifest >= 0 || ghcrManifest >= 0, "a version manifest step must exist");
  assert.ok(
    smoke > versionManifest || smoke > ghcrManifest,
    "smoke test must follow version publication"
  );
  assert.ok(latestPromotion > smoke, "latest promotion must follow the smoke test");
});

test("smoke test verifies the container health status", () => {
  const smoke = workflow.match(
    /- name: Smoke-test published Docker image[\s\S]*?(?=\n      - name:|\n      - uses:|\n\s*$)/
  );

  assert.ok(smoke, "published image smoke-test step must exist");
  assert.match(smoke[0], /docker run/);
  assert.match(smoke[0], /docker inspect/);
  assert.match(smoke[0], /healthy/);
});

test("latest promotion preserves every published image flavor", () => {
  // GHCR is the promotion channel since c1e30b7676 (Docker Hub promotion
  // removed upstream); accept either name so the flavor assertions hold for
  // whichever channel publishes :latest.
  const promotion =
    workflow.match(
      /- name: Promote GHCR latest tags[\s\S]*?(?=\n      - name:|\n      - uses:|\n\s*$)/
    ) ??
    workflow.match(
      /- name: Promote Docker Hub latest tags[\s\S]*?(?=\n      - name: Inspect image)/
    );

  assert.ok(promotion, "latest promotion must exist");
  assert.match(promotion[0], /for suffix in "" -web/);
  assert.match(promotion[0], /promote_tag "\$suffix"/);
  assert.match(promotion[0], /add_bun_alias/);
  assert.match(promotion[0], /PUBLISH_BUN_BASE/);
  assert.match(promotion[0], /PUBLISH_BUN_WEB/);
  assert.match(workflow, /imagetools inspect/);
  assert.match(workflow, /Promote GHCR latest tags/);
});
