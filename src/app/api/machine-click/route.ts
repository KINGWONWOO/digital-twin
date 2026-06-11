// UE5 PlayerController가 기계 클릭 시 HTTP POST로 이 엔드포인트를 호출
// React 대시보드는 GET으로 폴링해서 최근 클릭된 기계 ID를 받아 모달을 연다

let lastClick: { id: string; ts: number } | null = null;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (body?.id) {
    lastClick = { id: String(body.id), ts: Date.now() };
  }
  return Response.json({ ok: true });
}

export async function GET() {
  return Response.json(lastClick);
}
