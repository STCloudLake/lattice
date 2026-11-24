import { describe, expect, it } from 'vitest';
import {
  createEventFactory,
  prerequisiteEdges,
  replay,
  stateDigest,
  type LatticeEvent,
} from '@lattice/core';
import {
  ExtractionError,
  buildMergePlan,
  extractCandidate,
  normalizeSource,
  planToEvents,
  generateCurriculum,
  gradeDifficulty,
  resolveIdentity,
  validateCandidateJson,
  type LlmPort,
  type LlmRequest,
} from '../src/index.js';

interface FakeLlm extends LlmPort {
  calls: LlmRequest[];
}

function fakeLlm(responses: string[]): FakeLlm {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async complete(request) {
      calls.push(request);
      const next = responses.shift();
      if (next === undefined) throw new Error('fake LLM ran out of responses');
      return next;
    },
  };
}

const GOOD_OUTPUT = JSON.stringify({
  domain: '经济学',
  propositions: [
    {
      ref: 'p1',
      statement: '机会成本是放弃的最佳替代方案的价值。',
      name: '机会成本',
      aliases: ['opportunity cost'],
      quote: '机会成本是你为了得到某样东西而放弃的最佳替代方案的价值。',
    },
    {
      ref: 'p2',
      statement: '在预算约束下最大化效用会使需求曲线向右下倾斜。',
      quote: '在预算约束下最大化效用，需求曲线向右下倾斜。',
    },
    {
      ref: 'p3',
      statement: '需求曲线向右下倾斜意味着价格上升时需求量下降。',
      quote: '需求曲线向右下倾斜',
    },
  ],
  chains: [{ premises: ['p1', 'p2'], conclusion: 'p3', strength: 0.7 }],
});

const ctx = () => {
  let n = 0;
  const newId = () => 'id' + String(++n).padStart(4, '0');
  const factory = createEventFactory({
    deviceId: 'test',
    newId,
    now: () => new Date('2026-11-24T00:00:00.000Z'),
  });
  return { newId, factory };
};

describe('normalizeSource', () => {
  it('collapses whitespace and produces a stable fingerprint', () => {
    const a = normalizeSource({ text: '  第一段\r\n\r\n\r\n第二段   ', capturedAt: '2026-11-24T00:00:00.000Z' });
    const b = normalizeSource({ text: '第一段\n\n第二段', capturedAt: '2026-11-24T00:00:00.000Z' });
    expect(a.text).toBe('第一段\n\n第二段');
    expect(a.sourceHash).toBe(b.sourceHash);
  });

  it('rejects empty input', () => {
    expect(() => normalizeSource({ text: '   ' })).toThrow(ExtractionError);
  });

  it('distinguishes different content', () => {
    const a = normalizeSource({ text: '甲' });
    const b = normalizeSource({ text: '乙' });
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });
});

describe('extractCandidate', () => {
  it('parses fenced JSON and validates it', async () => {
    const llm = fakeLlm(['```json\n' + GOOD_OUTPUT + '\n```']);
    const source = normalizeSource({ text: '测试文本', capturedAt: '2026-11-24T00:00:00.000Z' });
    const result = await extractCandidate(source, { llm });
    expect(result.candidate.domain).toBe('经济学');
    expect(result.candidate.propositions).toHaveLength(3);
    expect(result.candidate.chains).toHaveLength(1);
    expect(result.promptVersion).toBe('extract-v2');
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.messages[0]!.content).toContain('知识抽取器');
  });

  it('raises a typed error on non-JSON output', async () => {
    const llm = fakeLlm(['抱歉，我无法完成。']);
    const source = normalizeSource({ text: '测试' });
    await expect(extractCandidate(source, { llm })).rejects.toBeInstanceOf(ExtractionError);
  });

  it('raises with issues when validity checks fail', async () => {
    const llm = fakeLlm([JSON.stringify({ propositions: [], chains: [] })]);
    const source = normalizeSource({ text: '测试' });
    await expect(extractCandidate(source, { llm })).rejects.toMatchObject({ issues: expect.any(Array) });
  });

  it('drops chains that reference unknown propositions', async () => {
    const output = JSON.stringify({
      propositions: [{ ref: 'p1', statement: '一个足够长的陈述句。', quote: '片段' }],
      chains: [{ premises: ['p9'], conclusion: 'p1' }],
    });
    const llm = fakeLlm([output]);
    const source = normalizeSource({ text: '测试' });
    const result = await extractCandidate(source, { llm });
    expect(result.candidate.chains).toHaveLength(0);
  });
});

describe('resolveIdentity', () => {
  it('skips the model entirely when there is nothing to compare against', async () => {
    const llm = fakeLlm([]);
    const source = normalizeSource({ text: '测试' });
    const { candidate } = await extractCandidate(source, { llm: fakeLlm([GOOD_OUTPUT]) });
    const identity = await resolveIdentity(candidate, [], { llm });
    expect(llm.calls).toHaveLength(0);
    expect([...identity.decisions.values()].every((d) => d.existingId === null)).toBe(true);
  });

  it('links a paraphrase to an existing proposition', async () => {
    const source = normalizeSource({ text: '测试' });
    const { candidate } = await extractCandidate(source, { llm: fakeLlm([GOOD_OUTPUT]) });
    const llm = fakeLlm([
      JSON.stringify({
        decisions: [
          { ref: 'p1', existingId: 'e1', reason: '同义' },
          { ref: 'p2', existingId: null },
          { ref: 'p3', existingId: null },
        ],
      }),
    ]);
    const identity = await resolveIdentity(candidate, [{ id: 'e1', statement: '机会成本' }], { llm });
    expect(identity.decisions.get('p1')?.existingId).toBe('e1');
    expect(identity.decisions.get('p2')?.existingId).toBeNull();
  });

  it('ignores ids that were never offered', async () => {
    const source = normalizeSource({ text: '测试' });
    const { candidate } = await extractCandidate(source, { llm: fakeLlm([GOOD_OUTPUT]) });
    const llm = fakeLlm([JSON.stringify({ decisions: [{ ref: 'p1', existingId: 'made-up' }] })]);
    const identity = await resolveIdentity(candidate, [{ id: 'e1', statement: '机会成本' }], { llm });
    expect(identity.decisions.get('p1')?.existingId).toBeNull();
    expect(identity.unresolved.length).toBeGreaterThan(0);
  });
});

describe('merge plan + events', () => {
  it('creates propositions with provenance, cues and chains', async () => {
    const source = normalizeSource({
      text: '机会成本的原文……',
      title: '经济学讲义',
      sourceKind: 'paste',
      capturedAt: '2026-11-24T00:00:00.000Z',
    });
    const { candidate } = await extractCandidate(source, { llm: fakeLlm([GOOD_OUTPUT]) });
    const identity = await resolveIdentity(candidate, [], { llm: fakeLlm([]) });
    const plan = buildMergePlan(candidate, identity);
    expect(plan.create).toHaveLength(3);
    expect(plan.cues).toHaveLength(3);
    expect(plan.chains).toHaveLength(1);

    const { factory, newId } = ctx();
    const { events } = planToEvents(plan, { factory, newId, source, actor: 'llm:test@extract-v1' });
    const state = replay(events);

    expect(Object.keys(state.propositions)).toHaveLength(3);
    expect(Object.keys(state.cues)).toHaveLength(3);
    expect(Object.keys(state.chains)).toHaveLength(1);
    // A capture is an interest signal: the domain is recorded even for new content.
    expect(Object.keys(state.interests)).toHaveLength(1);
    expect(Object.values(state.interests)[0]?.name).toBe('经济学');
    expect(Object.values(state.propositions).every((p) => p.domain === '经济学')).toBe(true);

    const first = Object.values(state.propositions)[0]!;
    expect(first.provenance[0]?.title).toBe('经济学讲义');
    expect(first.provenance[0]?.span?.quote).toBeTruthy();

    const edges = prerequisiteEdges(state);
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((e) => e.to))).toEqual(new Set([Object.values(state.chains)[0]!.conclusionId]));
  });

  it('is deterministic for the same plan', async () => {
    const source = normalizeSource({ text: '同样的文本', capturedAt: '2026-11-24T00:00:00.000Z' });
    const { candidate } = await extractCandidate(source, { llm: fakeLlm([GOOD_OUTPUT]) });
    const identity = await resolveIdentity(candidate, [], { llm: fakeLlm([]) });
    const plan = buildMergePlan(candidate, identity);

    const a = ctx();
    const b = ctx();
    const ea = planToEvents(plan, { factory: a.factory, newId: a.newId, source }).events;
    const eb = planToEvents(plan, { factory: b.factory, newId: b.newId, source }).events;
    expect(ea.map((e: LatticeEvent) => e.type)).toEqual(eb.map((e) => e.type));
    expect(stateDigest(replay(ea))).toBe(stateDigest(replay(eb)));
  });

  it('does not create propositions that were resolved to an existing id', async () => {
    const source = normalizeSource({ text: '测试' });
    const { candidate } = await extractCandidate(source, { llm: fakeLlm([GOOD_OUTPUT]) });
    const identity = await resolveIdentity(candidate, [{ id: 'e1', statement: '机会成本' }], {
      llm: fakeLlm([
        JSON.stringify({
          decisions: [
            { ref: 'p1', existingId: 'e1' },
            { ref: 'p2', existingId: null },
            { ref: 'p3', existingId: null },
          ],
        }),
      ]),
    });
    const plan = buildMergePlan(candidate, identity);
    expect(plan.create.map((c) => c.ref)).toEqual(['p2', 'p3']);
    expect(plan.reuse).toEqual([{ ref: 'p1', existingId: 'e1' }]);
  });
});


describe('generateCurriculum', () => {
  it('forces the declared domain and uses the curriculum prompt', async () => {
    const llm = fakeLlm([
      JSON.stringify({
        domain: '模型自己写的领域',
        propositions: [
          { ref: 'c1', statement: '算法是解决问题的有限步骤序列。', name: '算法' },
          { ref: 'c2', statement: '时间复杂度描述增长趋势。', name: '复杂度' },
        ],
        chains: [{ premises: ['c2'], conclusion: 'c1', strength: 0.5 }],
      }),
    ]);
    const result = await generateCurriculum({ domain: '计算机', level: 'beginner', count: 2 }, { llm });
    expect(result.candidate.domain).toBe('计算机');
    expect(result.promptVersion).toBe('curriculum-v2');
    expect(llm.calls[0]!.messages[0]!.content).toContain('课程设计者');
    expect(llm.calls[0]!.messages[1]!.content).toContain('计算机');
  });

  it('rejects output that is not JSON', async () => {
    const llm = fakeLlm(['我给你讲个故事']);
    await expect(generateCurriculum({ domain: '计算机', level: 'beginner' }, { llm })).rejects.toBeInstanceOf(
      ExtractionError,
    );
  });
});


describe('difficulty grading', () => {
  it('reads difficulty from extraction output', async () => {
    const output = JSON.stringify({
      domain: '计算机',
      propositions: [
        {
          ref: 'p1',
          statement: '一个需要应用的条件判断。',
          quote: '原文',
          difficulty: { tier: 3, cognitive: 'apply', minutes: 12 },
        },
      ],
      chains: [],
    });
    const source = normalizeSource({ text: '测试文本' });
    const { candidate } = await extractCandidate(source, { llm: fakeLlm([output]) });
    expect(candidate.propositions[0]?.difficulty).toEqual({ tier: 3, cognitive: 'apply', minutes: 12 });
  });

  it('downgrades invalid tiers to tier 3 with a warning', async () => {
    const output = JSON.stringify({
      propositions: [{ ref: 'p1', statement: '一条足够长的命题。', difficulty: { tier: 9, cognitive: 'evaluate' } }],
      chains: [],
    });
    const result = validateCandidateJson(JSON.parse(output));
    expect(result.candidate?.propositions[0]?.difficulty?.tier).toBe(3);
    expect(result.issues.some((issue) => issue.path.includes('tier'))).toBe(true);
  });

  it('asks the curriculum model for difficulty', async () => {
    const llm = fakeLlm([
      JSON.stringify({
        domain: '计算机',
        propositions: [{ ref: 'p1', statement: '课程命题。', difficulty: { tier: 2, cognitive: 'understand' } }],
        chains: [],
      }),
    ]);
    const result = await generateCurriculum({ domain: '计算机', level: 'beginner', count: 1 }, { llm });
    expect(llm.calls[0]!.messages[0]!.content).toContain('difficulty');
    expect(result.candidate.propositions[0]?.difficulty?.tier).toBe(2);
  });

  it('batch-grades existing points and reports dropped refs', async () => {
    const llm = fakeLlm([
      JSON.stringify({
        grades: [
          { ref: 'a', tier: 4, cognitive: 'analyze', minutes: 30, why: '需要推导边界' },
          { ref: 'b', tier: 99, cognitive: 'remember' },
        ],
      }),
    ]);
    const result = await gradeDifficulty(
      [
        { ref: 'a', statement: '推导命题。' },
        { ref: 'b', statement: '坏评分命题。' },
        { ref: 'c', statement: '被模型漏掉的命题。' },
      ],
      { llm },
    );
    expect(result.promptVersion).toBe('grading-v1');
    expect(result.grades).toHaveLength(1);
    expect(result.grades[0]).toMatchObject({ ref: 'a', tier: 4, cognitive: 'analyze' });
    expect(result.dropped).toEqual(expect.arrayContaining(['b', 'c']));
  });
});
