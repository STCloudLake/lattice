import type { ExistingProposition, ExtractedProposition, LlmMessage, NormalizedSource } from './types.js';

/**
 * Prompts are versioned. Changing wording changes extraction behaviour, so the
 * version travels with the events' actor (`llm:<model>@<promptVersion>`) and can
 * be compared in the coverage ledger.
 */
export const EXTRACT_PROMPT_VERSION = 'extract-v1';
export const IDENTIFY_PROMPT_VERSION = 'identify-v1';

export const EXTRACT_SYSTEM = `你是知识抽取器。把给定文本拆成「命题」和「推理链」。

规则：
1. 命题是一个可以被相信为真的陈述句，原子、单一判断。不要合并两个判断。
2. 每个命题必须能在原文中找到依据：quote 必须是原文的逐字片段（不超过 120 字）。
   找不到依据就不要输出这个命题。
3. 推理链表示「若干前提共同推出一个结论」。只有原文明确论证、或显然由这些前提共同
   支持时才输出链。前提多于一个时，它们是合起来起作用，不是各自单独推出结论。
4. 不要引入原文没有的知识。不要输出重复命题。没有可学内容时输出空数组。
5. 命题数量控制在 3–12 条之间（文本很短时可以更少）。用原文的语言书写。

只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释。格式：
{
  "propositions": [
    {"ref":"p1","statement":"完整的陈述句","name":"短标签（可选）","aliases":["同义说法"],"quote":"原文逐字片段"}
  ],
  "chains": [
    {"premises":["p1","p2"],"conclusion":"p3","strength":0.8}
  ]
}
strength 是 0–1 的置信度。没有 chain 时给空数组。`;

export function buildExtractMessages(source: NormalizedSource): LlmMessage[] {
  const header = [
    source.title ? `标题：${source.title}` : null,
    source.sourceUri ? `来源：${source.sourceUri}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: EXTRACT_SYSTEM },
    {
      role: 'user',
      content: `${header ? header + '\n\n' : ''}文本：\n"""\n${source.text}\n"""`,
    },
  ];
}

export const IDENTIFY_SYSTEM = `你在做命题去重。给你「候选命题」和「已有命题」，判断每个候选是否与
某条已有命题表达同一个判断。

规则：
1. 只使用给出的已有命题 id。不要发明 id。
2. 同义改写、换了措辞但含义相同 → 指向已有 id。
3. 范围、量词、条件不同（例如「所有」vs「有些」、「在A下」vs 无条件）→ 视为不同，给 null。
4. 不要因为主题相近就合并。
5. 必须为每个候选给出决定，不要遗漏。

只输出一个 JSON 对象：
{"decisions":[{"ref":"p1","existingId":"<已有 id 或 null>","reason":"一句话"}]}`;

export function buildIdentifyMessages(
  candidates: ExtractedProposition[],
  existing: ExistingProposition[],
): LlmMessage[] {
  const cand = candidates.map((p) => ({ ref: p.ref, statement: p.statement, name: p.name ?? null }));
  const ex = existing.map((p) => ({ id: p.id, statement: p.statement, aliases: p.aliases ?? [] }));
  return [
    { role: 'system', content: IDENTIFY_SYSTEM },
    {
      role: 'user',
      content:
        '候选命题：\n' +
        JSON.stringify(cand, null, 1) +
        '\n\n已有命题：\n' +
        JSON.stringify(ex, null, 1),
    },
  ];
}
