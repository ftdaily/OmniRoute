import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import vi from "../../src/i18n/messages/vi.json" with { type: "json" };

type MessageEntry = {
  key: string;
  value: string;
};

function flattenMessages(value: unknown, segments: Array<string | number> = []): MessageEntry[] {
  if (typeof value === "string") {
    return [{ key: segments.map(String).join("."), value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => flattenMessages(child, [...segments, index]));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      flattenMessages(child, [...segments, key])
    );
  }
  return [];
}

const vietnameseMessages = flattenMessages(vi);

test("Vietnamese locale has no internal missing markers or empty fallbacks", () => {
  const invalid = vietnameseMessages.filter(
    ({ value }) => !value.trim() || /__(?:MISSING|TODO)__:?/i.test(value)
  );
  assert.deepEqual(invalid, []);
});

test("no-auth provider controls keep locale translators unambiguous", () => {
  const source = readFileSync(
    new URL(
      "../../src/app/(dashboard)/dashboard/providers/[id]/components/NoAuthProviderControls.tsx",
      import.meta.url
    ),
    "utf8"
  );

  assert.equal(source.match(/import \{ useTranslations \} from "next-intl";/g)?.length, 1);
  assert.match(source, /const noAuthT = useTranslations\("noAuthProvider"\);/);
  assert.match(source, /const t = useTranslations\("providers"\);/);
});
