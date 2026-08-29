import { DefaultExecutor } from "./default.ts";

/**
 * CodeBuddy International executor — codebuddy.ai.
 *
 * OpenAI-compatible but stream-only, same rejection (HTTP 400, code 11101
 * "Non-stream chat request is currently not supported") as the CN gateway.
 * Force stream=true on every request; OmniRoute still re-aggregates SSE for
 * non-streaming clients. In contrast to CN, the intl backend does not
 * require a neutral-prompt rewrite — its content filter is more permissive.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials) as Record<
      string,
      unknown
    >;
    transformed.stream = true;

    // OpenAI-style reasoning_effort is honored on the intl backend; map
    // "none"/"off" to absence (the upstream rejects explicit "off"), keep
    // everything else as-is and tag reasoning_summary.
    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // codebuddy.ai rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks.
    const source = Array.isArray(transformed.messages)
      ? (transformed.messages as Array<Record<string, unknown>>)
      : [];
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "You are CodeBuddy Code." },
    ];
    for (const message of source) {
      if (!message || typeof message !== "object") continue;
      if (["system", "developer"].includes(message.role as string)) continue;
      if (message.role === "user" && typeof message.content === "string") {
        messages.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        messages.push({ ...message });
      }
    }
    transformed.messages = messages;

    return transformed;
  }
}

export default CodeBuddyIntlExecutor;
