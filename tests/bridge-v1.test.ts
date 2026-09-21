import { describe, it, expect } from 'vitest';
import { WaveMemoryBridge } from '../src/bridge.ts';

describe('WaveMemoryBridge v1 Runtime API 契约', () => {
  it('searchBookLore 发送标准请求与鉴权头', async () => {
    let calledUrl = '';
    let calledHeaders: Record<string, string> = {};
    let calledBody: any = null;

    const bridge = new WaveMemoryBridge('http://127.0.0.1:9876', async (url, init) => {
      calledUrl = url;
      calledHeaders = init?.headers ?? {};
      calledBody = JSON.parse(init?.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            items: [{ id: 'e1', resource: 'entities', title: '磁极神君', content: '设定内容', scores: { score: 0.9, rank: 1 }, provenance: {} }],
            mode: 'hybrid',
            degraded: false,
            warnings: [],
          },
        }),
        text: async () => '',
      };
    }, 'test-token');

    const res = await bridge.searchBookLore({ query: '磁极神君', mode: 'hybrid', top_k: 3 });
    expect(res.ok).toBe(true);
    expect(calledUrl).toBe('http://127.0.0.1:9876/api/runtime/v1/book-lore/search');
    expect(calledHeaders['Authorization']).toBe('Bearer test-token');
    expect(calledBody.query).toBe('磁极神君');
    expect(res.data?.items[0].title).toBe('磁极神君');
  });

  it('graphBookLore 发送图谱遍历请求', async () => {
    let calledUrl = '';
    const bridge = new WaveMemoryBridge('http://127.0.0.1:9876', async (url) => {
      calledUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            entity: { id: 'e1', title: '张羽', type: '人物', description: '主角' },
            relations: [{ id: 'r1', source: '磁极神君', target: '张羽', description: '师徒', weight: 0.9 }],
          },
        }),
        text: async () => '',
      };
    });

    const res = await bridge.graphBookLore({ entity_name: '张羽', depth: 1 });
    expect(res.ok).toBe(true);
    expect(calledUrl).toBe('http://127.0.0.1:9876/api/runtime/v1/book-lore/graph');
    expect(res.data?.entity?.title).toBe('张羽');
    expect(res.data?.relations.length).toBe(1);
  });

  it('executeCommand 发送 propose_fact 与 note_episode 结构化命令', async () => {
    let calledUrl = '';
    let calledBody: any = null;
    const bridge = new WaveMemoryBridge('http://127.0.0.1:9876', async (url, init) => {
      calledUrl = url;
      calledBody = JSON.parse(init?.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          operation_id: calledBody.operation_key,
          data: {
            command: calledBody.command,
            entity: { kind: 'fact', id: 'f-1', revision: 1 },
            transport_state: 'committed',
            domain_state: 'pending',
            projection_state: 'not_applicable',
            evidence_status: 'verified_source',
            duplicate: false,
          },
        }),
        text: async () => '',
      };
    });

    const res = await bridge.executeCommand({
      command: 'propose_fact',
      operation_key: 'op-1',
      scope: { bot_id: 'yushu', visibility: 'group' },
      arguments: {
        subject: 'bilibili:user:123',
        predicate: '偏好',
        object: '红石机关',
        source_quote: '我喜欢看你搭红石',
      },
    });

    expect(res.ok).toBe(true);
    expect(calledUrl).toBe('http://127.0.0.1:9876/api/runtime/v1/commands');
    expect(calledBody.command).toBe('propose_fact');
    expect(res.data?.domain_state).toBe('pending');
    expect(res.data?.evidence_status).toBe('verified_source');
  });

  it('submitObservations 批量提交被动弹幕与播出文本', async () => {
    let calledUrl = '';
    let calledBody: any = null;
    const bridge = new WaveMemoryBridge('http://127.0.0.1:9876', async (url, init) => {
      calledUrl = url;
      calledBody = JSON.parse(init?.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          batch_id: calledBody.batch_id,
          receipts: [{ event_id: 'ev-1', status: 'accepted', delivery_state: 'inbox_enqueued' }],
        }),
        text: async () => '',
      };
    });

    const res = await bridge.submitObservations({
      batch_id: 'b-test',
      events: [
        {
          event_id: 'ev-1',
          content: '弹幕内容测试',
          sender_id: '123',
          sender_name: '弹幕观众',
        },
      ],
    });

    expect(res.ok).toBe(true);
    expect(calledUrl).toBe('http://127.0.0.1:9876/api/runtime/v1/observations/batch');
    expect(calledBody.events.length).toBe(1);
    expect(res.receipts?.[0].status).toBe('accepted');
  });
});
