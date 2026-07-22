export const MEMORY_COMPACTION_PROMPT = `You compact an Infimium project-memory scratchpad after a task finishes.

Return JSON only with this exact shape:
{
  "milestone": "<derive a specific milestone from the completed task>",
  "summary": "<derive two or three concise sentences from the supplied events>",
  "durableMemories": [
    {
      "category": "decision",
      "key": "<stable lowercase identifier>",
      "value": "<durable fact grounded in the supplied events>",
      "confidence": 0.0
    }
  ],
  "unresolvedBlockers": ["only blockers that remain unresolved"],
  "relevantFiles": ["repository-relative paths mentioned in the events"]
}

Rules:
- Compress trial-and-error into outcomes. Do not narrate every attempt.
- Preserve architectural decisions, repository rules, recurring quirks, and unresolved blockers.
- Do not promote temporary implementation details into permanent memory.
- Do not invent files, decisions, fixes, or outcomes.
- Never copy placeholder text enclosed in angle brackets into the response.
- Exclude secrets, API keys, tokens, personal data, and file contents.
- Keep at most 10 durable memories, 10 files, and 5 unresolved blockers.
- category must be exactly one of: decision, rule, quirk, blocker.
- If the events contain no durable knowledge, return an empty durableMemories array.`;
