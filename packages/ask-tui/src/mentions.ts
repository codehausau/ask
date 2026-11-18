/** Shared syntax for typed/pasted mentions and picker insertions. No shell evaluation. */
export function chatRefs(text: string): string[] {
  return [...text.matchAll(/(?:^|[\s(])@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s)]+))/g)]
    .map((match) => match[1] ?? match[2] ?? match[3]!.replace(/[,;:]$/, ""));
}

/** Return null instead of inserting a reference that could select another file. */
export function serializeMention(target: string): string | null {
  if (!target || /[\r\n]/.test(target)) return null;
  const candidates = [`@${target}`, `@"${target}"`, `@'${target}'`];
  for (const candidate of candidates) {
    const refs = chatRefs(candidate + " ");
    if (refs.length === 1 && refs[0] === target) return candidate;
  }
  return null;
}

/** The editor supplies a prefix in JS characters, after converting cell offsets. */
export function activeMention(prefix: string) {
  const match = /(?:^|[\s(])(@(?:"[^"\n]*|'[^'\n]*|[^\s)]*))$/.exec(prefix);
  if (!match) return null;
  const token = match[1]!;
  return {
    prefix, start: prefix.length - token.length,
    query: token.slice(1).replace(/^["']/, "").replace(/["']$/, ""),
  };
}
