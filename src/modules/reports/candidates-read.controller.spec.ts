import type { Response } from 'express';
import { CandidatesReadController } from './candidates-read.controller.js';
import type { CandidatesReadService } from './candidates-read.service.js';
import type { SessionReportPdfService } from './pdf/session-report-pdf.service.js';
import type { SessionReviewService } from './session-review.service.js';

const A = '0b8f7d1e-6c2a-4f1e-9a52-3d6c1b2a4e5f';
const B = '1c9a8e2f-7d3b-4a2f-8b63-4e7d2c3b5f6a';

function setup() {
  const candidates = {
    exportCsv: vi.fn().mockResolvedValue('Name,Email\r\nNeha,n@x.io\r\n'),
  };
  const controller = new CandidatesReadController(
    candidates as unknown as CandidatesReadService,
    {} as SessionReviewService,
    {} as SessionReportPdfService,
  );
  const response = () => {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (k: string, v: string) => (headers[k] = v),
    } as unknown as Response;
    return { res, headers };
  };
  return { controller, candidates, response };
}

describe('CandidatesReadController export.csv', () => {
  it('POST returns the same CSV attachment as GET for the same ids', async () => {
    const { controller, candidates, response } = setup();
    const get = response();
    const post = response();
    const viaGet = await controller.exportCsv({ ids: [A, B] }, get.res);
    const viaPost = await controller.exportCsvPost({ ids: [A, B] }, post.res);
    expect(viaPost).toBe(viaGet);
    expect(post.headers).toEqual(get.headers);
    expect(post.headers).toEqual({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="candidates.csv"',
    });
    expect(candidates.exportCsv.mock.calls).toEqual([[[A, B]], [[A, B]]]);
  });

  it('GET with no ids exports everyone', async () => {
    const { controller, candidates, response } = setup();
    await controller.exportCsv({}, response().res);
    expect(candidates.exportCsv).toHaveBeenCalledWith([]);
  });
});
